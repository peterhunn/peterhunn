import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { identityRepo, type Db } from "@atelier/db";
import type { ActorType } from "@atelier/domain";

// /me — whoami, plus token management for the current actor.
//
// GET  /me                     resolved actor
// GET  /me/tokens              tokens owned by this actor (metadata)
// POST /me/tokens/rotate       revoke the current token, mint a new one
// POST /me/tokens/:tokenId/revoke   explicit revoke

const RotateBody = z
  .object({
    ttlSeconds: z.number().int().positive().max(365 * 24 * 60 * 60).optional(),
  })
  .default({});

export const meRoutes = (db: Db): FastifyPluginAsync => async (app) => {
  const identity = identityRepo(db);

  app.get("/me", async (req) => ({ actor: req.actor }));

  app.get("/me/tokens", async (req) => ({
    tokens: identity.listTokens(req.actor.type as ActorType, req.actor.id),
  }));

  app.post("/me/tokens/rotate", async (req, reply) => {
    if (!req.tokenId) {
      return reply.code(400).send({
        error: "no_token_context",
        message: "Rotate requires an authenticated bearer token.",
      });
    }
    const parsed = RotateBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_body", issues: parsed.error.issues });
    }
    const rotated = identity.rotateToken(
      req.tokenId,
      parsed.data.ttlSeconds !== undefined
        ? { ttlSeconds: parsed.data.ttlSeconds }
        : {},
    );
    if (!rotated) return reply.code(404).send({ error: "not_found" });
    return reply.code(201).send({
      token: rotated.token,
      tokenId: rotated.tokenId,
      expiresAt: rotated.expiresAt,
      note: "Copy this token — it is shown once and never again.",
    });
  });

  app.post<{ Params: { tokenId: string } }>(
    "/me/tokens/:tokenId/revoke",
    async (req, reply) => {
      // A caller may only revoke their own tokens. Enforced by
      // checking the target token belongs to the same actor.
      const tokens = identity.listTokens(
        req.actor.type as ActorType,
        req.actor.id,
      );
      const owned = tokens.find((t) => t.id === req.params.tokenId);
      if (!owned) return reply.code(404).send({ error: "not_found" });
      identity.revokeToken(req.params.tokenId);
      return reply.code(204).send();
    },
  );
};
