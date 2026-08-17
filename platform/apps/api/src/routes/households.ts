import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { householdRepo } from "@atelier/db";
import { HouseholdTier, HouseholdRiskTier, type HouseholdId } from "@atelier/domain";
import type { Db } from "@atelier/db";

const CreateHouseholdBody = z.object({
  name: z.string().min(1),
  tier: HouseholdTier,
  riskTier: HouseholdRiskTier.optional(),
});

export const householdRoutes = (db: Db): FastifyPluginAsync => async (app) => {
  const repo = householdRepo(db);

  app.get("/households", async () => ({
    households: repo.list(),
  }));

  app.get<{ Params: { id: string } }>("/households/:id", async (req, reply) => {
    const household = repo.get(req.params.id as HouseholdId);
    if (!household) return reply.code(404).send({ error: "not_found" });
    return { household };
  });

  app.post("/households", async (req, reply) => {
    const body = CreateHouseholdBody.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", issues: body.error.issues });
    }
    const household = repo.create(body.data);
    return reply.code(201).send({ household });
  });
};
