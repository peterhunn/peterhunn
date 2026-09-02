import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { modelCallRepo, type Db } from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";
import { getRegistry, getRouter, inferenceBudgetFor } from "../runtime.js";

const SelectQuery = z.object({
  taskClass: z.string(),
});

export const modelRoutes = (db: Db): FastifyPluginAsync => async (app) => {
  const mc = modelCallRepo(db);

  app.get("/models", async () => ({ models: getRegistry().listModels() }));

  app.get("/models/task-classes", async () => ({
    taskClasses: getRegistry().listTaskClasses(),
  }));

  // Dry-run the router. Useful for the console models page and for
  // sanity-checking policy changes without spending on the model.
  app.get("/models/select", async (req, reply) => {
    const q = SelectQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    try {
      const sel = getRouter().select({ taskClass: q.data.taskClass });
      return {
        primary: sel.primary,
        fallbacks: sel.fallbacks,
        resolvedTier: sel.resolvedTier,
        minTier: sel.minTier,
        reasons: sel.reasons,
      };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get<{ Params: { householdId: string } }>(
    "/households/:householdId/model-calls",
    { config: { audit: { action: "model_calls.list", resourceType: "model_call" } } },
    async (req) => ({
      modelCalls: mc.list(req.householdContext as HouseholdId),
    }),
  );

  app.get<{ Params: { householdId: string } }>(
    "/households/:householdId/inference-budget",
    { config: { audit: { action: "inference_budget.get", resourceType: "budget" } } },
    async (req) => inferenceBudgetFor(db, req.householdContext as HouseholdId),
  );
};
