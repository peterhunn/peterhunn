import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { credentialRepo, inboxRepo, type Db } from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";
import { syncGmailInbox } from "@atelier/agents";

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
  })
  .default({});

export const inboxRoutes = (db: Db): FastifyPluginAsync => async (app) => {
  const inbox = inboxRepo(db);
  const credentials = credentialRepo(db);

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
        ...parsed.data,
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

      const result = await syncGmailInbox(
        {
          householdId,
          readCredential: (provider) => credentials.getSecret(householdId, provider),
          persistAccessToken: (id, at, exp) => credentials.updateAccessToken(id, at, exp),
          logger: {
            info: (msg, ctx) => req.log.info({ ...(ctx as object) }, msg),
          },
        },
        {
          upsertMessage: (i) => inbox.upsertExternal(i),
        },
        body.data,
      );

      if (!result.consulted) {
        return reply.code(400).send({
          error: "gmail_not_connected",
          message:
            "No `gmail` credential is stored for this household. Connect Google to enable sync.",
        });
      }
      if (result.error) {
        return reply.code(502).send({ error: "gmail_sync_failed", detail: result.error });
      }
      return { sync: result };
    },
  );
};
