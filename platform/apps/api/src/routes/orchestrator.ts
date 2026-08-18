import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Intent } from "@atelier/agents";
import { taskRepo, type Db } from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";
import { buildGraphView, buildGraphWriter, buildOrchestrator } from "../runtime.js";

const PlanAndRunBody = z.object({
  prompt: z.string().min(1),
  origin: z
    .object({
      source: z.enum(["customer", "manager", "proactive", "system"]),
      by: z.string(),
    })
    .default({ source: "manager", by: "console" }),
});

export const orchestratorRoutes = (db: Db): FastifyPluginAsync => async (app) => {
  const tasks = taskRepo(db);

  app.post<{ Params: { householdId: string } }>(
    "/households/:householdId/orchestrator/run",
    { config: { audit: { action: "orchestrator.run", resourceType: "orchestrator_run" } } },
    async (req, reply) => {
      const parsed = Intent.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_intent", issues: parsed.error.issues });
      }
      const orch = buildOrchestrator(db);
      const householdId = req.householdContext as HouseholdId;
      const result = await orch.run({
        householdId,
        actor: {
          type: req.actor.type,
          id: req.actor.id,
          displayName: req.actor.displayName,
        },
        graph: buildGraphView(db, householdId),
        writer: buildGraphWriter(db, householdId, `${req.actor.type}:${req.actor.id}`),
        intent: parsed.data,
      });
      return { run: result };
    },
  );

  app.get<{ Params: { householdId: string } }>(
    "/households/:householdId/orchestrator/runs",
    { config: { audit: { action: "orchestrator.list_runs", resourceType: "orchestrator_run" } } },
    async (req) => ({ runs: tasks.listRuns(req.householdContext as HouseholdId) }),
  );

  app.get<{ Params: { householdId: string } }>(
    "/households/:householdId/tasks",
    { config: { audit: { action: "task.list", resourceType: "task" } } },
    async (req) => ({ tasks: tasks.listTasks(req.householdContext as HouseholdId) }),
  );

  app.post<{ Params: { householdId: string } }>(
    "/households/:householdId/orchestrator/plan-and-run",
    {
      config: {
        audit: { action: "orchestrator.plan_and_run", resourceType: "orchestrator_run" },
      },
    },
    async (req, reply) => {
      const parsed = PlanAndRunBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      }
      const orch = buildOrchestrator(db);
      const householdId = req.householdContext as HouseholdId;
      const result = await orch.planAndRun({
        householdId,
        actor: {
          type: req.actor.type,
          id: req.actor.id,
          displayName: req.actor.displayName,
        },
        graph: buildGraphView(db, householdId),
        writer: buildGraphWriter(db, householdId, `${req.actor.type}:${req.actor.id}`),
        prompt: parsed.data.prompt,
        origin: parsed.data.origin,
      });
      return { planAndRun: result };
    },
  );
};
