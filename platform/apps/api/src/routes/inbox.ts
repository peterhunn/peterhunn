import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  credentialRepo,
  inboxRepo,
  syncStateRepo,
  type Db,
} from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";
import { syncGmailInbox, type GmailSyncCursor } from "@atelier/agents";
import { stripUndefined } from "../util.js";

const CreateInboxMessageBody = z.object({
  fromName: z.string().min(1),
  fromAddress: z.string().email(),
  recipientPrincipalId: z.string().optional(),
  subject: z.string().min(1),
  body: z.string().min(1),
  receivedAt: z.string().datetime().optional(),
});

const SyncBody = z
  .object({
    maxResults: z.number().int().positive().max(100).optional(),
    // Which mailbox to pull. "inbox" (default) syncs unread INBOX,
    // "sent" syncs recent SENT — used to fill in the outbound half
    // of the per-customer timeline. "both" runs the two back-to-
    // back and returns a combined report; each mailbox has its own
    // history cursor under a different provider key so their
    // incremental pulls never crosstalk.
    mailbox: z.enum(["inbox", "sent", "both"]).optional(),
  })
  .default({});

export const inboxRoutes = (db: Db): FastifyPluginAsync => async (app) => {
  const inbox = inboxRepo(db);
  const credentials = credentialRepo(db);
  const sync = syncStateRepo(db);

  const gmailCursor: GmailSyncCursor = {
    read: (h, provider) => {
      const row = sync.get(h, provider);
      if (!row) return null;
      const c = row.cursor as { historyId?: string } | null;
      return c && typeof c.historyId === "string" ? { historyId: c.historyId } : null;
    },
    save: (h, provider, cursor, lastResult) =>
      sync.save(h, provider, cursor, lastResult),
    clear: (h, provider) => sync.clear(h, provider),
  };

  app.get<{ Params: { householdId: string } }>(
    "/households/:householdId/inbox",
    { config: { audit: { action: "inbox.list", resourceType: "inbox_message" } } },
    async (req) => ({ messages: inbox.list(req.householdContext as HouseholdId) }),
  );

  app.get<{ Params: { householdId: string; messageId: string } }>(
    "/households/:householdId/inbox/:messageId",
    { config: { audit: { action: "inbox.get", resourceType: "inbox_message" } } },
    async (req, reply) => {
      const msg = inbox.get(req.params.messageId);
      if (!msg || msg.householdId !== req.householdContext) {
        return reply.code(404).send({ error: "not_found" });
      }
      return { message: msg };
    },
  );

  app.post<{ Params: { householdId: string } }>(
    "/households/:householdId/inbox",
    { config: { audit: { action: "inbox.create", resourceType: "inbox_message" } } },
    async (req, reply) => {
      const parsed = CreateInboxMessageBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      }
      const msg = inbox.create({
        householdId: req.householdContext as HouseholdId,
        ...stripUndefined(parsed.data),
      });
      return reply.code(201).send({ message: msg });
    },
  );

  // Pull unread messages from Gmail into the household's inbox.
  // Requires a `gmail` credential — 400 with a clear reason if
  // absent, so the console can surface it.
  app.post<{ Params: { householdId: string } }>(
    "/households/:householdId/inbox/sync",
    {
      config: {
        audit: { action: "inbox.sync", resourceType: "inbox_message", sensitive: true },
      },
    },
    async (req, reply) => {
      const body = SyncBody.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: "invalid_body" });
      const householdId = req.householdContext as HouseholdId;
      const mailboxRequest = body.data.mailbox ?? "inbox";
      const mailboxes: Array<"inbox" | "sent"> =
        mailboxRequest === "both" ? ["inbox", "sent"] : [mailboxRequest];

      const ctx = {
        householdId,
        readCredential: (provider: string) => credentials.getSecret(householdId, provider),
        persistAccessToken: (id: string, at: string, exp: string) =>
          credentials.updateAccessToken(id, at, exp),
        logger: {
          info: (msg: string, ctx: unknown) =>
            req.log.info({ ...(ctx as object) }, msg),
        },
      };
      const sink = { upsertMessage: inbox.upsertExternal.bind(inbox) };

      const results: Array<{
        mailbox: "inbox" | "sent";
        result: Awaited<ReturnType<typeof syncGmailInbox>>;
      }> = [];
      for (const mailbox of mailboxes) {
        const result = await syncGmailInbox(ctx, sink, {
          ...(body.data.maxResults !== undefined && { maxResults: body.data.maxResults }),
          cursorStore: gmailCursor,
          mailbox,
        });
        results.push({ mailbox, result });
      }

      // All mailboxes share the same credential, so a "not
      // connected" verdict on the first pass applies to the whole
      // request. Bail once, not per-mailbox.
      const first = results[0]!.result;
      if (!first.consulted) {
        return reply.code(400).send({
          error: "gmail_not_connected",
          message:
            "No `gmail` credential is stored for this household. Connect Google to enable sync.",
        });
      }
      const errored = results.find((r) => r.result.error);
      if (errored) {
        return reply
          .code(502)
          .send({ error: "gmail_sync_failed", detail: errored.result.error, mailbox: errored.mailbox });
      }
      if (mailboxRequest === "both") {
        return { mailboxes: results };
      }
      // Legacy single-mailbox shape stays intact so the console's
      // existing sync button + tests don't need to change until
      // they want the sent side.
      return { sync: first };
    },
  );
};
