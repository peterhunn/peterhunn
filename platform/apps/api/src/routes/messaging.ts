import { createHmac } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  contactEndpointRepo,
  credentialRepo,
  messagingEventRepo,
  type Db,
  type MessagingChannel,
} from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";
import { sendTwilioMessage } from "@atelier/agents";
import { buildGraphView, buildGraphWriter, buildOrchestrator } from "../runtime.js";

// Customer messaging surface.
//
// Inbound: a webhook per provider (mock for local dev, twilio for
// SMS/WhatsApp) resolves an inbound number to a household via
// contact_endpoints, records the messaging event (deduped by the
// provider's message id), and dispatches the body to
// orchestrator.planAndRun. Ack is provider-appropriate: TwiML for
// twilio, JSON for mock.
//
// Manager-scoped CRUD on contact endpoints uses the household auth
// guard as usual. Recent messaging events read via GET.

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
    // The result carries per-intent runIds; we link the messaging
    // event to the planner run so the console can show "this SMS
    // triggered these tasks."
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
      const ep = endpoints.resolve(parsed.data.channel, parsed.data.to);
      if (!ep) {
        return reply.code(404).send({
          error: "unrouted",
          message: `No contact endpoint registered for ${parsed.data.channel}:${parsed.data.to}.`,
        });
      }
      const out = await dispatchToPlanner(db, req.log, {
        householdId: ep.householdId as HouseholdId,
        channel: parsed.data.channel,
        from: parsed.data.from,
        to: parsed.data.to,
        body: parsed.data.body,
        provider: "mock",
        ...(parsed.data.externalMessageId
          ? { externalMessageId: parsed.data.externalMessageId }
          : {}),
        endpointId: ep.id,
      });
      return {
        ok: true,
        eventId: out.eventId,
        deduped: out.deduped,
        ...(out.runId ? { plannerRunId: out.runId } : {}),
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

      const ep = endpoints.resolve(channel, to);
      if (!ep) {
        // Twilio still expects a 200 to stop retries; respond with an
        // empty TwiML so the sender doesn't get an auto-error.
        req.log.info({ channel, to }, "twilio inbound unrouted");
        return reply
          .header("content-type", "text/xml; charset=utf-8")
          .send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
      }

      const out = await dispatchToPlanner(db, req.log, {
        householdId: ep.householdId as HouseholdId,
        channel,
        from,
        to,
        body,
        provider: "twilio",
        ...(externalMessageId ? { externalMessageId } : {}),
        endpointId: ep.id,
      });

      const ack = out.deduped
        ? ""
        : `<Message>${escapeXml("Got it — I'm working on this and will follow up.")}</Message>`;
      return reply
        .header("content-type", "text/xml; charset=utf-8")
        .send(`<?xml version="1.0" encoding="UTF-8"?><Response>${ack}</Response>`);
    },
  );
};
