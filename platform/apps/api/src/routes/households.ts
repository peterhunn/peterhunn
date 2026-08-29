import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { householdRepo } from "@atelier/db";
import { HouseholdTier, HouseholdRiskTier, type HouseholdId } from "@atelier/domain";
import type { Db } from "@atelier/db";
import { stripUndefined } from "../util.js";
import { buildHouseholdSnapshot } from "../household-snapshot.js";

const CreateHouseholdBody = z.object({
  name: z.string().min(1),
  tier: HouseholdTier,
  riskTier: HouseholdRiskTier.optional(),
});

export const householdRoutes = (db: Db): FastifyPluginAsync => async (app) => {
  const repo = householdRepo(db);

  app.get("/households", async (req) => {
    const all = repo.list();
    if (req.actor.type === "manager") {
      const granted = new Set(req.actor.householdIds);
      return { households: all.filter((h) => granted.has(h.id)) };
    }
    return { households: all };
  });

  app.get<{ Params: { householdId: string } }>(
    "/households/:householdId",
    async (req, reply) => {
      const household = repo.get(req.params.householdId as HouseholdId);
      if (!household) return reply.code(404).send({ error: "not_found" });
      return { household };
    },
  );

  app.post("/households", async (req, reply) => {
    if (req.actor.type !== "manager" && req.actor.type !== "system") {
      return reply.code(403).send({ error: "not_permitted" });
    }
    const body = CreateHouseholdBody.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", issues: body.error.issues });
    }
    const household = repo.create(stripUndefined(body.data));
    return reply.code(201).send({ household });
  });

  // Household health snapshot — a single-shot rollup meant to be
  // shared with a customer as "here's what's happening across
  // your household right now". Every field is live, nothing
  // stored. See apps/api/src/household-snapshot.ts.
  app.get<{ Params: { householdId: string } }>(
    "/households/:householdId/snapshot",
    {
      config: {
        audit: { action: "household.snapshot", resourceType: "household" },
      },
    },
    async (req, reply) => {
      const snapshot = buildHouseholdSnapshot(
        db,
        req.householdContext as HouseholdId,
      );
      if (!snapshot) return reply.code(404).send({ error: "not_found" });
      return { snapshot };
    },
  );

  app.post<{ Params: { householdId: string }; Body: { enabled: boolean } }>(
    "/households/:householdId/autopilot",
    {
      config: {
        audit: { action: "household.autopilot.set", resourceType: "household" },
      },
    },
    async (req, reply) => {
      const body = z.object({ enabled: z.boolean() }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_body" });
      repo.setAutopilot(req.householdContext as HouseholdId, body.data.enabled);
      const household = repo.get(req.householdContext as HouseholdId);
      return { household };
    },
  );

  // Turn the concierge line's instant-ack SMS on or off for this
  // household. Off by default — the ack is an agent-authored SMS
  // going to the customer without manager review, which is a
  // customer-facing agent surface. See messaging.ts handleInbound.
  app.post<{ Params: { householdId: string }; Body: { enabled: boolean } }>(
    "/households/:householdId/instant-ack",
    {
      config: {
        audit: { action: "household.instant_ack.set", resourceType: "household" },
      },
    },
    async (req, reply) => {
      const body = z.object({ enabled: z.boolean() }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_body" });
      repo.setInstantAck(req.householdContext as HouseholdId, body.data.enabled);
      const household = repo.get(req.householdContext as HouseholdId);
      return { household };
    },
  );

  // Turn agent-authored sends on or off for this household. Off
  // by default. When off, sendOutboundMessage refuses any send
  // whose authoredBy.type === "agent" (and the orchestrator
  // refuses auto-execute of any communication-class tool). See
  // docs/32-customer-messaging.md §"Manager-mediated-only".
  app.post<{ Params: { householdId: string }; Body: { enabled: boolean } }>(
    "/households/:householdId/agent-sending",
    {
      config: {
        audit: {
          action: "household.agent_sending.set",
          resourceType: "household",
        },
      },
    },
    async (req, reply) => {
      const body = z.object({ enabled: z.boolean() }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_body" });
      repo.setAgentSending(
        req.householdContext as HouseholdId,
        body.data.enabled,
      );
      const household = repo.get(req.householdContext as HouseholdId);
      return { household };
    },
  );
};
