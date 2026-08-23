import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { identityRepo, type Db } from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";

// Routes tagged { public: true } skip the auth guard. Everything else
// requires a valid bearer token; every householdId path parameter is
// checked against the actor's grants before the handler runs.
declare module "fastify" {
  interface FastifyContextConfig {
    public?: boolean;
  }
}

export interface AuthPluginOpts {
  readonly db: Db;
}

const plugin: FastifyPluginAsync<AuthPluginOpts> = async (app, opts) => {
  const identity = identityRepo(opts.db);

  app.addHook("onRequest", async (req, reply) => {
    if (req.routeOptions.config?.public) return;

    const header = req.headers["authorization"];
    if (!header || !header.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "missing_token" });
    }
    const token = header.slice("Bearer ".length).trim();
    const resolution = identity.resolveToken(token);
    if (!resolution.ok) {
      // Distinguish the three failure modes so a client can react
      // differently: "invalid" = re-auth, "expired" = rotate,
      // "revoked" = a session was intentionally killed. Body
      // shape stays predictable for legacy clients that only
      // check the `error` string.
      return reply
        .code(401)
        .send({ error: `${resolution.reason}_token` });
    }
    req.actor = resolution.actor;
    req.tokenId = resolution.tokenId;

    const params = req.params as Record<string, string> | undefined;
    const householdId = params?.["householdId"];
    if (householdId) {
      if (
        resolution.actor.type === "manager" &&
        !resolution.actor.householdIds.includes(householdId as HouseholdId)
      ) {
        return reply.code(403).send({ error: "household_forbidden" });
      }
      req.householdContext = householdId as HouseholdId;
    }
  });
};

export const authPlugin = fp(plugin, { name: "atelier-auth" });
