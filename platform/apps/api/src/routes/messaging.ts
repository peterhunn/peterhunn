import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  contactEndpointRepo,
  conversationSessionRepo,
  credentialRepo,
  extractVerificationCode,
  graphRepo,
  householdRepo,
  messagingEventRepo,
  normalizeAddress,
  pendingVerificationRepo,
  type Db,
  type MessagingChannel,
} from "@atelier/db";
import type { HouseholdId, NodeId } from "@atelier/domain";
import { sendTwilioMessage, verifyTwilioInboundSignature } from "@atelier/agents";
import { buildGraphView, buildGraphWriter, buildOrchestrator } from "../runtime.js";
import { stripUndefined } from "../util.js";

// Customer messaging surface.
//
// Inbound resolution is two-step so the same webhook works for a
// dedicated-line deploy (customer texts a household's own Twilio
// number) and a shared-line deploy (many households share one
// concierge line, customers identify themselves by the from-number):
//   1. Try (channel, from) — the customer's own address as endpoint.
//   2. Fall back to (channel, to) — the household-owned DID case.
// If both miss, look for a live verification code in the body; on
// match, create the endpoint, mark the code consumed, ack the
// customer, and skip planner dispatch (this message was a claim, not
// a task). If none of that matches, ack minimally (no household
// context to log against) so Twilio doesn't retry.

const AddEndpointBody = z.object({
  channel: z.enum(["sms", "whatsapp", "imessage", "email"]),
  address: z.string().min(3),
  principalId: z.string().optional(),
  label: z.string().optional(),
});

const SendMessageBody = z.object({
  channel: z.enum(["sms", "whatsapp"]).default("sms"),
  to: z.string().min(3),
  body: z.string().min(1).max(1600),
  inReplyToEventId: z.string().optional(),
});

const CreateVerificationBody = z.object({
  channel: z.enum(["sms", "whatsapp", "imessage", "email"]).default("sms"),
  ttlSeconds: z.number().int().positive().max(24 * 60 * 60).optional(),
  label: z.string().optional(),
  principalId: z.string().optional(),
});

const InviteCustomerBody = z.object({
  channel: z.enum(["sms", "whatsapp"]).default("sms"),
  address: z.string().min(3),
  label: z.string().optional(),
  ttlSeconds: z.number().int().positive().max(24 * 60 * 60).optional(),
  // Optional override — the default message names the household
  // and the code, which is usually what you want.
  bodyOverride: z.string().max(320).optional(),
  // Optional person.* node id — the profile this number belongs
  // to. When set, every inbound message from that number carries
  // this principal into the planner so the run "knows who's
  // talking," not just which household.
  principalId: z.string().optional(),
});

const MockInboundBody = z.object({
  channel: z.enum(["sms", "whatsapp", "imessage", "email"]).default("sms"),
  from: z.string().min(3),
  to: z.string().min(3),
  body: z.string().min(1),
  externalMessageId: z.string().optional(),
});

// Twilio classic form-encoded webhook fields we care about.
interface TwilioForm {
  MessageSid?: string;
  SmsMessageSid?: string;
  From?: string;
  To?: string;
  Body?: string;
  WaId?: string;
}

// Signature verification delegates to twilio.validateRequest via
// the shared helper in @atelier/agents — same HMAC-SHA1 scheme,
// maintained by Twilio so future signature changes land there.
// We accept missing signatures only when ATELIER_TWILIO_AUTH_TOKEN
// is unset (dev mode); verification is required as soon as a token
// is configured so a production key can't leak signed requests.

// Shared concierge line configuration — the "one number for
// every customer" posture. When any of the ATELIER_TWILIO_*
// env vars are set, sends fall back to this platform-level
// credential if the household hasn't stored its own (dedicated
// line for an enterprise customer). Per-household credentials
// still take precedence so the same code path handles both
// shared and dedicated deploys.
interface ResolvedTwilio {
  readonly credential: {
    id?: string;
    credential: {
      account_sid?: string;
      auth_token?: string;
      from_number?: string;
      messaging_service_sid?: string;
    };
    expiresAt?: string;
  } | null;
  readonly source: "household" | "concierge" | "none";
  readonly conciergeNumber: string | null;
}

const platformConciergeCredential = (): ResolvedTwilio["credential"] => {
  const account_sid = process.env["ATELIER_TWILIO_ACCOUNT_SID"];
  const auth_token = process.env["ATELIER_TWILIO_AUTH_TOKEN"];
  const from_number = process.env["ATELIER_TWILIO_FROM_NUMBER"];
  const messaging_service_sid = process.env["ATELIER_TWILIO_MESSAGING_SERVICE_SID"];
  if (!account_sid || !auth_token) return null;
  if (!from_number && !messaging_service_sid) return null;
  return {
    credential: {
      account_sid,
      auth_token,
      ...(from_number && { from_number }),
      ...(messaging_service_sid && { messaging_service_sid }),
    },
  };
};

const resolveTwilioSender = (
  db: Db,
  householdId: HouseholdId,
): ResolvedTwilio => {
  const conciergeNumber = process.env["ATELIER_TWILIO_FROM_NUMBER"] ?? null;
  const perHousehold = credentialRepo(db).getSecret(householdId, "twilio");
  const looksComplete = (raw: { credential?: unknown } | null): boolean => {
    if (!raw) return false;
    const c = (raw.credential ?? {}) as Record<string, unknown>;
    return Boolean(
      c["account_sid"] &&
        c["auth_token"] &&
        (c["messaging_service_sid"] || c["from_number"]),
    );
  };
  if (looksComplete(perHousehold)) {
    return {
      credential: perHousehold as never,
      source: "household",
      conciergeNumber,
    };
  }
  const platform = platformConciergeCredential();
  if (platform) return { credential: platform, source: "concierge", conciergeNumber };
  return { credential: null, source: "none", conciergeNumber };
};

interface InboundResult {
  outcome:
    | "dispatched"
    | "deduped"
    | "verified"
    | "already_verified"
    | "opted_out"
    | "opted_in"
    | "unrouted";
  householdId?: HouseholdId;
  householdName?: string;
  eventId?: string;
  runId?: string;
  ackMessage?: string;
}

// TCPA-standard opt-out keywords. Twilio auto-recognises many of
// these on its side, but we still handle at the application layer
// so (a) the mock adapter honours them in dev, (b) non-Twilio
// channels behave the same, and (c) our own consent history is
// authoritative rather than "check Twilio's console."
const STOP_KEYWORDS = new Set([
  "stop",
  "stopall",
  "unsubscribe",
  "cancel",
  "end",
  "quit",
]);
const START_KEYWORDS = new Set(["start", "unstop", "yes"]);

const detectConsentKeyword = (
  body: string,
): "stop" | "start" | null => {
  const first = body.trim().split(/\s+/)[0]?.toLowerCase();
  if (!first) return null;
  if (STOP_KEYWORDS.has(first)) return "stop";
  if (START_KEYWORDS.has(first)) return "start";
  return null;
};

const STOP_CONFIRMATION =
  "You've been unsubscribed. Reply START to opt back in. Msg&data rates may apply.";
const START_CONFIRMATION =
  "You're resubscribed. Reply STOP to opt out at any time.";

// Refuse to send outbound to an endpoint that opted out. Returns
// null when the send is allowed, or a mock-shaped OutOfBand result
// carrying the reason when it's blocked. Callers should pass that
// result through in place of the real sendTwilioMessage response.
const outboundConsentGate = (
  db: Db,
  householdId: HouseholdId,
  channel: MessagingChannel,
  toAddress: string,
): { blocked: true; reason: string } | { blocked: false; endpoint: unknown | null } => {
  const ep = contactEndpointRepo(db).resolve(channel, toAddress);
  if (!ep) return { blocked: false, endpoint: null };
  if (ep.householdId !== householdId) return { blocked: false, endpoint: ep };
  if (ep.consentStatus === "opted_out") {
    return {
      blocked: true,
      reason: `opted_out_at_${ep.consentRecordedAt ?? "unknown_time"}`,
    };
  }
  return { blocked: false, endpoint: ep };
};

const dispatchToPlanner = async (
  db: Db,
  log: FastifyRequest["log"],
  input: {
    householdId: HouseholdId;
    channel: MessagingChannel;
    from: string;
    to: string;
    body: string;
    provider: string;
    externalMessageId?: string;
    endpointId?: string;
    principalId?: string;
    sessionId?: string;
    priorTurns?: readonly { role: "customer" | "agent"; content: string }[];
  },
): Promise<{ eventId: string; deduped: boolean; runId?: string }> => {
  const events = messagingEventRepo(db);
  const eventInput = {
    householdId: input.householdId,
    channel: input.channel,
    direction: "inbound" as const,
    fromAddress: input.from,
    toAddress: input.to,
    body: input.body,
    provider: input.provider,
    ...(input.externalMessageId ? { externalMessageId: input.externalMessageId } : {}),
    ...(input.endpointId ? { endpointId: input.endpointId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  };
  const { inserted, row } = events.record(eventInput);
  if (!inserted) {
    log.info({ eventId: row.id }, "messaging inbound deduped");
    return { eventId: row.id, deduped: true };
  }

  // If the endpoint is bound to a person node (person.principal
  // / .member / .staff / .contact), tell the planner who's
  // talking — not just which household. `fullName` is the shape
  // used by the people extractor + the person nodes; missing =
  // fall back to the from-address as before.
  let actorId = input.from;
  let actorDisplay = input.from;
  if (input.principalId) {
    const node = graphRepo(db).getNode(input.householdId, input.principalId as NodeId);
    if (node) {
      const data = node.data as { fullName?: string; name?: string };
      const name = data.fullName ?? data.name;
      actorId = node.id;
      if (name) actorDisplay = name;
    } else {
      log.info(
        { endpointId: input.endpointId, principalId: input.principalId },
        "endpoint principal points at a missing/superseded node — falling back to from-address",
      );
    }
  }

  try {
    const orch = buildOrchestrator(db);
    const result = await orch.planAndRun({
      householdId: input.householdId,
      actor: {
        type: "customer",
        id: actorId,
        displayName: actorDisplay,
      },
      graph: buildGraphView(db, input.householdId),
      writer: buildGraphWriter(
        db,
        input.householdId,
        `customer:${input.channel}:${input.from}`,
      ),
      prompt: input.body,
      origin: { source: "customer", by: `${input.channel}:${input.from}` },
      ...(input.priorTurns && input.priorTurns.length > 0
        ? { priorTurns: input.priorTurns }
        : {}),
    });
    const firstRun = result.runs[0]?.runId;
    if (firstRun) events.linkRun(row.id, firstRun);
    return { eventId: row.id, deduped: false, ...(firstRun ? { runId: firstRun } : {}) };
  } catch (err) {
    log.error(
      { error: (err as Error).message, eventId: row.id },
      "messaging planAndRun failed",
    );
    return { eventId: row.id, deduped: false };
  }
};

// Full inbound-side pipeline: shared-line vs dedicated-line
// resolution → verification claim on miss → planner dispatch on
// hit. Kept independent of the webhook shape so both the mock and
// Twilio endpoints ride the same code path.
const handleInbound = async (
  db: Db,
  log: FastifyRequest["log"],
  input: {
    channel: MessagingChannel;
    from: string;
    to: string;
    body: string;
    provider: string;
    externalMessageId?: string;
  },
): Promise<InboundResult> => {
  const endpoints = contactEndpointRepo(db);
  const events = messagingEventRepo(db);
  const verifications = pendingVerificationRepo(db);
  const households = householdRepo(db);

  // 1. Resolve by the customer's from-address first (shared-line
  //    deploy), then by the platform's to-address (dedicated-line
  //    deploy per household).
  const ep =
    endpoints.resolve(input.channel, input.from) ??
    endpoints.resolve(input.channel, input.to);
  if (ep) {
    // Consent keywords fire BEFORE dispatch so an opt-out message
    // isn't fed into the planner. Also fires before dedupe: the
    // consent transition is an idempotent state change, safe to
    // re-apply if Twilio retries the webhook.
    const consent = detectConsentKeyword(input.body);
    if (consent) {
      const status = consent === "stop" ? "opted_out" : "opted_in";
      endpoints.setConsent(ep.id, {
        status,
        source: consent === "stop" ? "reply_stop" : "reply_start",
      });
      // Record the inbound message itself so the household's
      // history shows the STOP arrived. Dedupe on external id
      // stays honoured — Twilio's retry policy needs this.
      const rec = events.record({
        householdId: ep.householdId as HouseholdId,
        channel: input.channel,
        direction: "inbound",
        fromAddress: input.from,
        toAddress: input.to,
        body: input.body,
        provider: input.provider,
        endpointId: ep.id,
        ...(input.externalMessageId ? { externalMessageId: input.externalMessageId } : {}),
      });
      // Confirmation reply. Bypasses the outbound gate (consent
      // confirmations are legally required regardless of status).
      const ack = consent === "stop" ? STOP_CONFIRMATION : START_CONFIRMATION;
      log.info(
        {
          endpointId: ep.id,
          from: input.from,
          consent: status,
        },
        `consent keyword handled — sending ${consent === "stop" ? "opt-out" : "opt-in"} confirmation`,
      );
      return {
        outcome: consent === "stop" ? "opted_out" : "opted_in",
        householdId: ep.householdId as HouseholdId,
        eventId: rec.row.id,
        ackMessage: ack,
      };
    }

    // Refuse to plan on messages from an opted-out endpoint. The
    // customer explicitly asked us to stop; still record the
    // inbound event so the audit trail shows they messaged after
    // opting out, but no reply and no planner dispatch.
    if (ep.consentStatus === "opted_out") {
      const rec = events.record({
        householdId: ep.householdId as HouseholdId,
        channel: input.channel,
        direction: "inbound",
        fromAddress: input.from,
        toAddress: input.to,
        body: input.body,
        provider: input.provider,
        endpointId: ep.id,
        ...(input.externalMessageId ? { externalMessageId: input.externalMessageId } : {}),
      });
      log.info(
        { endpointId: ep.id, from: input.from },
        "inbound from opted-out endpoint — recorded, planner not dispatched",
      );
      return {
        outcome: "opted_out",
        householdId: ep.householdId as HouseholdId,
        eventId: rec.row.id,
      };
    }

    // Conversation memory: open/resume the rolling session for
    // this endpoint. Recent turns become planner context — the
    // difference between "brand-new intent every message" and "a
    // conversation." Idle window (30m by default) closes stale
    // sessions automatically without a cleanup job.
    const sessions = conversationSessionRepo(db);
    const { session } = sessions.openOrResume({
      householdId: ep.householdId as HouseholdId,
      endpointId: ep.id,
      ...(ep.principalId ? { principalId: ep.principalId } : {}),
    });
    // Recent turns, oldest first. Filter deduped rows out (they'd
    // add noise), and cap body length so a pathological long
    // message doesn't blow the prompt window.
    const priorTurns = events
      .listBySession(session.id, 20)
      .map((e) => ({
        role: (e.direction === "inbound" ? "customer" : "agent") as
          | "customer"
          | "agent",
        content: e.body.length > 1000 ? `${e.body.slice(0, 1000)}…` : e.body,
      }));

    const out = await dispatchToPlanner(db, log, {
      householdId: ep.householdId as HouseholdId,
      channel: input.channel,
      from: input.from,
      to: input.to,
      body: input.body,
      provider: input.provider,
      ...(input.externalMessageId ? { externalMessageId: input.externalMessageId } : {}),
      endpointId: ep.id,
      ...(ep.principalId ? { principalId: ep.principalId } : {}),
      sessionId: session.id,
      ...(priorTurns.length > 0 ? { priorTurns } : {}),
    });
    return {
      outcome: out.deduped ? "deduped" : "dispatched",
      householdId: ep.householdId as HouseholdId,
      eventId: out.eventId,
      ...(out.runId ? { runId: out.runId } : {}),
    };
  }

  // 2. No endpoint → look for a verification code in the body.
  //    If one matches a live pending verification, bind the
  //    from-address as a new endpoint for that household and mark
  //    the code consumed. The customer is now onboarded.
  const code = extractVerificationCode(input.body);
  if (code) {
    const pending = verifications.findLiveByCode(input.channel, code);
    if (pending) {
      const normalizedFrom = normalizeAddress(input.channel, input.from);
      // If the same address is already an endpoint on this
      // household (maybe registered manually), still consume the
      // code so the pending list clears — just don't double-insert.
      const existing = endpoints.resolve(input.channel, normalizedFrom);
      let endpointId: string;
      if (existing && existing.householdId === pending.householdId) {
        endpointId = existing.id;
      } else if (existing) {
        // The address is bound to a different household — refuse
        // the verification to prevent hijacking.
        log.info(
          { code, otherHousehold: existing.householdId },
          "verification claim refused — from-address already bound elsewhere",
        );
        return { outcome: "unrouted" };
      } else {
        const created = endpoints.create({
          householdId: pending.householdId as HouseholdId,
          channel: input.channel,
          address: normalizedFrom,
          ...(pending.label && { label: pending.label }),
          ...(pending.principalId && { principalId: pending.principalId }),
        });
        endpointId = created.id;
      }
      // Customer just texted a valid code — that IS the consent
      // signal. Stamp opted_in with source "reply_yes" so future
      // outbound to this endpoint is authorized under TCPA-style
      // rules and the audit trail shows who consented when.
      endpoints.setConsent(endpointId, {
        status: "opted_in",
        source: "reply_yes",
      });
      verifications.consume(pending.id, normalizedFrom, endpointId);
      // Record the claim itself as an inbound messaging event so
      // the household's traffic view carries a full history.
      events.record({
        householdId: pending.householdId as HouseholdId,
        endpointId,
        direction: "inbound",
        channel: input.channel,
        provider: input.provider,
        ...(input.externalMessageId ? { externalMessageId: input.externalMessageId } : {}),
        fromAddress: input.from,
        toAddress: input.to,
        body: input.body,
      });
      const hh = households.get(pending.householdId as HouseholdId);
      return {
        outcome: existing ? "already_verified" : "verified",
        householdId: pending.householdId as HouseholdId,
        householdName: hh?.name ?? "your household",
        ackMessage: `Verified — you're now connected to ${hh?.name ?? "your household"}. Text again anytime.`,
      };
    }
  }

  return { outcome: "unrouted" };
};

const escapeXml = (s: string): string =>
  s.replace(/[<>&'"]/g, (c) =>
    c === "<"
      ? "&lt;"
      : c === ">"
        ? "&gt;"
        : c === "&"
          ? "&amp;"
          : c === "'"
            ? "&apos;"
            : "&quot;",
  );

export const messagingRoutes = (db: Db): FastifyPluginAsync => async (app) => {
  const endpoints = contactEndpointRepo(db);
  const events = messagingEventRepo(db);

  // ── Manager-scoped CRUD ────────────────────────────────────────
  app.get<{ Params: { householdId: string } }>(
    "/households/:householdId/messaging/endpoints",
    {
      config: {
        audit: { action: "messaging.endpoints.list", resourceType: "contact_endpoint" },
      },
    },
    async (req) => ({
      endpoints: endpoints.list(req.householdContext as HouseholdId),
    }),
  );

  app.post<{ Params: { householdId: string } }>(
    "/households/:householdId/messaging/endpoints",
    {
      config: {
        audit: { action: "messaging.endpoints.create", resourceType: "contact_endpoint" },
      },
    },
    async (req, reply) => {
      const parsed = AddEndpointBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      }
      try {
        const row = endpoints.create({
          householdId: req.householdContext as HouseholdId,
          ...stripUndefined(parsed.data),
        });
        return reply.code(201).send({ endpoint: row });
      } catch (err) {
        // Unique index violation → this address is already routed
        // somewhere. Surface clearly so the console can explain.
        const msg = (err as Error).message;
        if (/UNIQUE/.test(msg)) {
          return reply.code(409).send({
            error: "address_already_routed",
            message: "This channel+address is already registered.",
          });
        }
        throw err;
      }
    },
  );

  app.delete<{ Params: { householdId: string; endpointId: string } }>(
    "/households/:householdId/messaging/endpoints/:endpointId",
    {
      config: {
        audit: { action: "messaging.endpoints.revoke", resourceType: "contact_endpoint" },
      },
    },
    async (req, reply) => {
      const ep = endpoints.get(req.params.endpointId);
      if (!ep || ep.householdId !== req.householdContext) {
        return reply.code(404).send({ error: "not_found" });
      }
      endpoints.revoke(ep.id);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { householdId: string } }>(
    "/households/:householdId/messaging/send",
    {
      config: {
        audit: {
          action: "messaging.send",
          resourceType: "messaging_event",
          sensitive: true,
        },
      },
    },
    async (req, reply) => {
      const parsed = SendMessageBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      }
      const householdId = req.householdContext as HouseholdId;
      const gate = outboundConsentGate(db, householdId, parsed.data.channel, parsed.data.to);
      if (gate.blocked) {
        return reply.code(403).send({
          error: "recipient_opted_out",
          message:
            "This recipient has opted out. Outbound refused. Ask them to reply START to opt back in.",
          reason: gate.reason,
        });
      }
      const sender = resolveTwilioSender(db, householdId);
      const out = await sendTwilioMessage(sender.credential as never, parsed.data, {
        logger: {
          info: (msg, ctx) => req.log.info({ ...(ctx as object) }, msg),
        },
      });
      // If the recipient endpoint has an open session, tag the
      // outbound with its id so the reply lands in the running
      // conversation history — the next inbound turn will see it
      // as prior agent context.
      const recipEp =
        (gate.blocked === false ? gate.endpoint as { id: string } | null : null) ??
        contactEndpointRepo(db).resolve(parsed.data.channel, parsed.data.to);
      let outboundSessionId: string | undefined;
      if (recipEp) {
        const openSessions = conversationSessionRepo(db).listOpenForEndpoint(recipEp.id);
        outboundSessionId = openSessions[0]?.id;
      }
      const record = events.record({
        householdId,
        direction: "outbound",
        channel: parsed.data.channel,
        provider: out.provider,
        externalMessageId: out.externalMessageId,
        fromAddress: out.from,
        toAddress: out.to,
        body: parsed.data.body,
        ...(outboundSessionId ? { sessionId: outboundSessionId } : {}),
      });
      return {
        sent: {
          provider: out.provider,
          externalMessageId: out.externalMessageId,
          from: out.from,
          to: out.to,
          eventId: record.row.id,
          ...(out.status ? { status: out.status } : {}),
          ...(out.reason ? { reason: out.reason } : {}),
        },
      };
    },
  );

  app.get<{ Params: { householdId: string } }>(
    "/households/:householdId/messaging/events",
    {
      config: {
        audit: { action: "messaging.events.list", resourceType: "messaging_event" },
      },
    },
    async (req) => ({
      events: events.list(req.householdContext as HouseholdId),
    }),
  );

  // ── Public webhooks ────────────────────────────────────────────
  // Mock — for local dev and tests. Accepts JSON.
  app.post(
    "/messaging/inbound/mock",
    {
      config: {
        public: true,
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const parsed = MockInboundBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      }
      const out = await handleInbound(db, req.log, {
        channel: parsed.data.channel,
        from: parsed.data.from,
        to: parsed.data.to,
        body: parsed.data.body,
        provider: "mock",
        ...(parsed.data.externalMessageId
          ? { externalMessageId: parsed.data.externalMessageId }
          : {}),
      });
      if (out.outcome === "unrouted") {
        return reply.code(404).send({
          error: "unrouted",
          message: `No contact endpoint or live verification for ${parsed.data.channel}:${parsed.data.from} → ${parsed.data.to}.`,
        });
      }
      return {
        ok: true,
        outcome: out.outcome,
        ...(out.eventId ? { eventId: out.eventId } : {}),
        ...(out.householdId ? { householdId: out.householdId } : {}),
        ...(out.runId ? { plannerRunId: out.runId } : {}),
        ...(out.ackMessage ? { ackMessage: out.ackMessage } : {}),
      };
    },
  );

  // Twilio SMS + WhatsApp — accepts form-encoded webhook bodies.
  // Signature verified against ATELIER_TWILIO_AUTH_TOKEN when set.
  // If the account token is unset, we accept (dev mode) and log a
  // one-line warning so it's visible.
  app.post(
    "/messaging/inbound/twilio",
    {
      config: {
        public: true,
        // Twilio's normal retry cadence is 5 retries over ~1 hour,
        // so 60/min per IP is generous. A misbehaving source can't
        // burn the planner's LLM budget by flooding.
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const raw = (req.body ?? {}) as Record<string, string>;
      const form: TwilioForm = raw as TwilioForm;
      const authToken = process.env["ATELIER_TWILIO_AUTH_TOKEN"];
      if (authToken) {
        // Reconstruct the full URL Twilio signed against. Trust the
        // reverse proxy's X-Forwarded-Proto/Host if set.
        const proto =
          (req.headers["x-forwarded-proto"] as string | undefined) ??
          (req.protocol as string);
        const host =
          (req.headers["x-forwarded-host"] as string | undefined) ??
          (req.headers["host"] as string | undefined) ??
          "";
        const fullUrl = `${proto}://${host}${req.url}`;
        const sig =
          (req.headers["x-twilio-signature"] as string | undefined) ?? undefined;
        const ok = verifyTwilioInboundSignature({
          authToken,
          fullUrl,
          params: raw,
          ...(sig ? { signature: sig } : {}),
        });
        if (!ok) {
          return reply.code(403).send({ error: "invalid_signature" });
        }
      } else {
        req.log.info("twilio webhook accepted without verification (auth token unset)");
      }

      const channel: MessagingChannel = (form.From ?? "").startsWith("whatsapp:")
        ? "whatsapp"
        : "sms";
      // Twilio prefixes whatsapp with "whatsapp:+E164"; strip it.
      const strip = (s: string): string =>
        s.startsWith("whatsapp:") ? s.slice("whatsapp:".length) : s;
      const from = strip(form.From ?? "");
      const to = strip(form.To ?? "");
      const body = form.Body ?? "";
      const externalMessageId = form.MessageSid ?? form.SmsMessageSid;

      const out = await handleInbound(db, req.log, {
        channel,
        from,
        to,
        body,
        provider: "twilio",
        ...(externalMessageId ? { externalMessageId } : {}),
      });

      let ackText: string | null = null;
      if (out.outcome === "dispatched") {
        ackText = "Got it — I'm working on this and will follow up.";
      } else if (out.outcome === "verified") {
        ackText = out.ackMessage ?? "Verified.";
      } else if (out.outcome === "already_verified") {
        ackText = out.ackMessage ?? "You're already connected.";
      } else if (out.outcome === "opted_out" || out.outcome === "opted_in") {
        // Legally-required confirmation for STOP/START. Bypasses
        // the outbound consent gate (confirmations must send even
        // to opted-out endpoints).
        ackText = out.ackMessage ?? null;
      }
      // "deduped" and "unrouted" both return an empty TwiML — we
      // don't want to double-reply to a retried webhook, and we
      // don't want to tip an outsider that unrouted numbers just
      // silently get dropped.
      if (out.outcome === "unrouted") {
        req.log.info({ channel, from, to }, "twilio inbound unrouted");
      }
      const inner = ackText ? `<Message>${escapeXml(ackText)}</Message>` : "";
      return reply
        .header("content-type", "text/xml; charset=utf-8")
        .send(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`);
    },
  );

  // ── Verifications (manager-scoped) ─────────────────────────────
  const verifications = pendingVerificationRepo(db);

  app.get<{ Params: { householdId: string } }>(
    "/households/:householdId/messaging/verifications",
    {
      config: {
        audit: {
          action: "messaging.verifications.list",
          resourceType: "pending_verification",
        },
      },
    },
    async (req) => ({
      verifications: verifications.list(req.householdContext as HouseholdId),
    }),
  );

  app.post<{ Params: { householdId: string } }>(
    "/households/:householdId/messaging/verifications",
    {
      config: {
        audit: {
          action: "messaging.verifications.create",
          resourceType: "pending_verification",
        },
      },
    },
    async (req, reply) => {
      const parsed = CreateVerificationBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      }
      const created = verifications.create({
        householdId: req.householdContext as HouseholdId,
        channel: parsed.data.channel,
        createdBy: `${req.actor.type}:${req.actor.id}`,
        ...(parsed.data.ttlSeconds ? { ttlSeconds: parsed.data.ttlSeconds } : {}),
        ...(parsed.data.label ? { label: parsed.data.label } : {}),
        ...(parsed.data.principalId ? { principalId: parsed.data.principalId } : {}),
      });
      return reply.code(201).send({
        verification: {
          id: created.id,
          channel: created.channel,
          code: created.code,
          expiresAt: created.expiresAt,
          label: created.label,
        },
      });
    },
  );

  // Shared-line customer onboarding — mint a verification code
  // AND send the invite SMS from the concierge line in one step.
  // Replaces the manual "create the code, tell the customer by
  // hand what to text" flow. The customer just replies with the
  // code to +concierge and the inbound webhook binds their number
  // to this household.
  app.post<{ Params: { householdId: string } }>(
    "/households/:householdId/messaging/invite",
    {
      config: {
        audit: {
          action: "messaging.invite",
          resourceType: "pending_verification",
          sensitive: true,
        },
      },
    },
    async (req, reply) => {
      const parsed = InviteCustomerBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      }
      const householdId = req.householdContext as HouseholdId;
      const household = householdRepo(db).get(householdId);
      if (!household) return reply.code(404).send({ error: "household_not_found" });

      const gate = outboundConsentGate(db, householdId, parsed.data.channel, parsed.data.address);
      if (gate.blocked) {
        return reply.code(403).send({
          error: "recipient_opted_out",
          message:
            "This number opted out and cannot be re-invited via SMS. The customer must text START from that number themselves.",
          reason: gate.reason,
        });
      }

      const sender = resolveTwilioSender(db, householdId);
      // No Twilio configured is fine — the send falls to mock (same
      // policy as /messaging/send). The response body's sent.reason
      // carries the "no_twilio_credential" note so the console can
      // surface it.

      const pending = verifications.create({
        householdId,
        channel: parsed.data.channel,
        createdBy: `${req.actor.type}:${req.actor.id}`,
        ...(parsed.data.ttlSeconds ? { ttlSeconds: parsed.data.ttlSeconds } : {}),
        ...(parsed.data.label ? { label: parsed.data.label } : {}),
        ...(parsed.data.principalId ? { principalId: parsed.data.principalId } : {}),
      });

      const body =
        parsed.data.bodyOverride ??
        `Atelier: reply with ${pending.code} to connect this number to ${household.name}. Code expires ${new Date(pending.expiresAt).toLocaleString("en-US", { timeZone: "UTC", hour12: false })} UTC. Reply STOP to opt out. Msg&data rates may apply.`;

      const out = await sendTwilioMessage(
        sender.credential as never,
        { channel: parsed.data.channel, to: parsed.data.address, body },
        { logger: { info: (msg, ctx) => req.log.info({ ...(ctx as object) }, msg) } },
      );

      const recorded = events.record({
        householdId,
        direction: "outbound",
        channel: parsed.data.channel,
        provider: out.provider,
        externalMessageId: out.externalMessageId,
        fromAddress: out.from,
        toAddress: out.to,
        body,
      });

      return reply.code(201).send({
        invite: {
          verificationId: pending.id,
          code: pending.code,
          expiresAt: pending.expiresAt,
          senderSource: sender.source,
        },
        sent: {
          provider: out.provider,
          externalMessageId: out.externalMessageId,
          from: out.from,
          to: out.to,
          eventId: recorded.row.id,
          ...(out.status ? { status: out.status } : {}),
          ...(out.reason ? { reason: out.reason } : {}),
        },
      });
    },
  );

  // Rolling conversations. One row per open session, most-recent
  // activity first. Includes the last turn so the console can
  // preview it without a second fetch.
  app.get<{ Params: { householdId: string } }>(
    "/households/:householdId/messaging/sessions",
    {
      config: {
        audit: { action: "messaging.sessions.list", resourceType: "conversation_session" },
      },
    },
    async (req) => {
      const householdId = req.householdContext as HouseholdId;
      const sessions = conversationSessionRepo(db);
      const endpoints = contactEndpointRepo(db);
      const open = endpoints
        .list(householdId)
        .flatMap((ep) => sessions.listOpenForEndpoint(ep.id));
      const list = open.map((s) => {
        const turns = events.listBySession(s.id, 50);
        const last = turns[turns.length - 1];
        return {
          id: s.id,
          endpointId: s.endpointId,
          principalId: s.principalId,
          startedAt: s.startedAt,
          lastActivityAt: s.lastActivityAt,
          turnCount: turns.length,
          ...(last ? {
            lastTurn: {
              direction: last.direction,
              body: last.body.length > 200 ? `${last.body.slice(0, 200)}…` : last.body,
              at: last.receivedAt,
            },
          } : {}),
        };
      });
      return { sessions: list };
    },
  );

  // Public — the console (or an operator's status page) can read
  // this without auth to see whether shared-line is live and which
  // number to tell customers to text.
  app.get(
    "/messaging/config",
    {
      config: {
        public: true,
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
    },
    async () => {
      const concierge = platformConciergeCredential();
      const from = process.env["ATELIER_TWILIO_FROM_NUMBER"];
      const svc = process.env["ATELIER_TWILIO_MESSAGING_SERVICE_SID"];
      return {
        conciergeNumber: from && from.length > 0 ? from : null,
        conciergeMessagingServiceSid: svc && svc.length > 0 ? svc : null,
        sharedLineActive: Boolean(concierge),
      };
    },
  );
};
