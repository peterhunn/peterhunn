import type { FastifyPluginAsync } from "fastify";
import { Intent } from "@atelier/agents";
import { taskRepo, type Db } from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";
import { buildGraphView, buildOrchestrator } from "../runtime.js";

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
};
