import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { inboxRepo, type Db } from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";

const CreateInboxMessageBody = z.object({
  fromName: z.string().min(1),
  fromAddress: z.string().email(),
  recipientPrincipalId: z.string().optional(),
  subject: z.string().min(1),
  body: z.string().min(1),
  receivedAt: z.string().datetime().optional(),
});

export const inboxRoutes = (db: Db): FastifyPluginAsync => async (app) => {
  const inbox = inboxRepo(db);

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
};
