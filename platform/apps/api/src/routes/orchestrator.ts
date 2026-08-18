import type { FastifyPluginAsync } from "fastify";
import {
  Orchestrator,
  ToolRegistry,
  householdAgent,
  vendorScheduleTool,
  Intent,
} from "@atelier/agents";
import {
  actionRepo,
  graphRepo,
  householdRepo,
  policyRepo,
  taskRepo,
  type Db,
} from "@atelier/db";
import { evaluate as evaluatePolicy } from "@atelier/policy";
import type { ActionRequest, HouseholdId } from "@atelier/domain";

// Wire the runtime up per household on demand. Instances are cheap and
// stateless; nothing in the orchestrator or its agents holds per-
// household state between requests.
const buildRuntime = (db: Db) => {
  const tools = new ToolRegistry();
  tools.register(vendorScheduleTool);

  const policies = policyRepo(db);
  const actions = actionRepo(db);
  const households = householdRepo(db);
  const tasks = taskRepo(db);

  return new Orchestrator({
    agents: [householdAgent],
    tools,
    ledger: {
      startRun: (i) => tasks.startRun(i),
      finishRun: (id, s) => tasks.finishRun(id, s),
      createTask: (i) => tasks.createTask(i),
      updateTask: (id, i) => {
        tasks.updateTask(id, {
          state: i.state as never,
          ...(i.outputs !== undefined && { outputs: i.outputs }),
          ...(i.decisionSummary !== undefined && { decisionSummary: i.decisionSummary }),
          ...(i.errorMessage !== undefined && { errorMessage: i.errorMessage }),
        });
      },
      listTasksForRun: (runId) =>
        tasks.listTasksForRun(runId).map((t) => ({
          id: t.id,
          agent: t.agent,
          kind: t.kind,
          state: t.state,
          decisionSummary: t.decisionSummary,
          outputs: t.outputs,
          errorMessage: t.errorMessage,
        })),
    },
    policy: {
      evaluate: (hh, req: ActionRequest) =>
        evaluatePolicy(
          {
            policies: { match: (i) => policies.match(i) },
            rollups: {
              amountRollup: (h, ac, r) => actions.amountRollup(h, ac, r),
              countRollup: (h, ac, r) => actions.countRollup(h, ac, r),
            },
            household: { isFrozen: (h) => households.get(h)?.frozenAt !== undefined },
          },
          { householdId: hh, request: req },
        ),
    },
    actions: {
      record: (i) => actions.record(i),
    },
  });
};

const buildGraphView = (db: Db, householdId: HouseholdId) => {
  const graph = graphRepo(db);
  return {
    listNodes: (opts?: { type?: string }) =>
      graph
        .listNodes(householdId, opts?.type ? { type: opts.type as never } : {})
        .map((n) => ({
          id: n.id,
          type: n.type,
          data: n.data as Record<string, unknown>,
        })),
  };
};

export const orchestratorRoutes = (db: Db): FastifyPluginAsync => async (app) => {
  const tasks = taskRepo(db);

  app.post<{ Params: { householdId: string } }>(
    "/households/:householdId/orchestrator/run",
    {
      config: {
        audit: { action: "orchestrator.run", resourceType: "orchestrator_run" },
      },
    },
    async (req, reply) => {
      const parsed = Intent.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_intent", issues: parsed.error.issues });
      }
      const orch = buildRuntime(db);
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
