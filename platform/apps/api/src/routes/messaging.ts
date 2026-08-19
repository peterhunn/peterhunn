import { createHmac } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  contactEndpointRepo,
  credentialRepo,
  extractVerificationCode,
  householdRepo,
  messagingEventRepo,
  normalizeAddress,
  pendingVerificationRepo,
  type Db,
  type MessagingChannel,
} from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";
import { sendTwilioMessage } from "@atelier/agents";
import { buildGraphView, buildGraphWriter, buildOrchestrator } from "../runtime.js";

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

// Twilio computes an HMAC-SHA1 of (fullUrl + sortedFormPairsConcatenated)
// with the account auth token as the key, base64-encoded. We accept
// missing signatures only when ATELIER_TWILIO_AUTH_TOKEN is unset
// (dev mode) — verification is required as soon as a token is
// configured so a production key can't leak signed requests.
const verifyTwilioSignature = (
  fullUrl: string,
  form: Record<string, string>,
  signature: string | undefined,
  authToken: string,
): boolean => {
  if (!signature) return false;
  const keys = Object.keys(form).sort();
  let signed = fullUrl;
  for (const k of keys) signed += k + form[k];
  const expected = createHmac("sha1", authToken).update(signed).digest("base64");
  return expected === signature;
};

interface InboundResult {
  outcome: "dispatched" | "deduped" | "verified" | "already_verified" | "unrouted";
  householdId?: HouseholdId;
  householdName?: string;
  eventId?: string;
  runId?: string;
  ackMessage?: string;
}

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
  };
  const { inserted, row } = events.record(eventInput);
  if (!inserted) {
    log.info({ eventId: row.id }, "messaging inbound deduped");
    return { eventId: row.id, deduped: true };
  }

  try {
    const orch = buildOrchestrator(db);
    const result = await orch.planAndRun({
      householdId: input.householdId,
      actor: {
        type: "customer",
        id: input.from,
        displayName: input.from,
      },
      graph: buildGraphView(db, input.householdId),
      writer: buildGraphWriter(
        db,
        input.householdId,
        `customer:${input.channel}:${input.from}`,
      ),
      prompt: input.body,
      origin: { source: "customer", by: `${input.channel}:${input.from}` },
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
    const out = await dispatchToPlanner(db, log, {
      householdId: ep.householdId as HouseholdId,
      channel: input.channel,
      from: input.from,
      to: input.to,
      body: input.body,
      provider: input.provider,
      ...(input.externalMessageId ? { externalMessageId: input.externalMessageId } : {}),
      endpointId: ep.id,
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
          label: pending.label ?? undefined,
        });
        endpointId = created.id;
      }
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
          ...parsed.data,
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
      const credentials = credentialRepo(db);
      const twilioCred = credentials.getSecret(householdId, "twilio");
      const out = await sendTwilioMessage(twilioCred, parsed.data, {
        logger: {
          info: (msg, ctx) => req.log.info({ ...(ctx as object) }, msg),
        },
      });
      const record = events.record({
        householdId,
        direction: "outbound",
        channel: parsed.data.channel,
        provider: out.provider,
        externalMessageId: out.externalMessageId,
        fromAddress: out.from,
        toAddress: out.to,
        body: parsed.data.body,
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
    { config: { public: true } },
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
    { config: { public: true } },
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
        if (!verifyTwilioSignature(fullUrl, raw, sig, authToken)) {
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
};
