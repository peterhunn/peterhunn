import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { credentialRepo, type Db } from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";

const StoreCredentialBody = z.object({
  provider: z.string().min(1),
  kind: z.enum(["oauth2", "api_key", "token", "other"]),
  label: z.string().min(1),
  principalRef: z.string().optional(),
  credential: z.record(z.unknown()),
  scopes: z.array(z.string()).optional(),
  expiresAt: z.string().datetime().optional(),
});

export const credentialRoutes = (db: Db): FastifyPluginAsync => async (app) => {
  const repo = credentialRepo(db);

  // List — returns metadata only, never the raw credential blob.
  app.get<{ Params: { householdId: string } }>(
    "/households/:householdId/credentials",
    {
      config: {
        audit: { action: "credential.list", resourceType: "credential", sensitive: true },
      },
    },
    async (req) => ({ credentials: repo.list(req.householdContext as HouseholdId) }),
  );

  app.post<{ Params: { householdId: string } }>(
    "/households/:householdId/credentials",
    {
      config: {
        audit: { action: "credential.store", resourceType: "credential", sensitive: true },
      },
    },
    async (req, reply) => {
      if (req.actor.type !== "manager" && req.actor.type !== "system") {
        return reply.code(403).send({ error: "not_permitted" });
      }
      const body = StoreCredentialBody.safeParse(req.body);
      if (!body.success) {
        return reply.code(400).send({ error: "invalid_body", issues: body.error.issues });
      }
      const stored = repo.store({
        householdId: req.householdContext as HouseholdId,
        ...body.data,
      });
      return reply.code(201).send({ credential: stored });
    },
  );

  app.post<{ Params: { householdId: string; credentialId: string } }>(
    "/households/:householdId/credentials/:credentialId/revoke",
    {
      config: {
        audit: { action: "credential.revoke", resourceType: "credential", sensitive: true },
      },
    },
    async (req, reply) => {
      repo.revoke(req.params.credentialId);
      return reply.code(204).send();
    },
  );
};
