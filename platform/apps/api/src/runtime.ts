import {
  Orchestrator,
  ToolRegistry,
  householdAgent,
  vendorScheduleTool,
  vendorPurchaseTool,
} from "@atelier/agents";
import {
  actionRepo,
  approvalRepo,
  graphRepo,
  householdRepo,
  policyRepo,
  taskRepo,
  type Db,
} from "@atelier/db";
import { evaluate as evaluatePolicy } from "@atelier/policy";
import type { ActionRequest, HouseholdId } from "@atelier/domain";

// A shared factory so route handlers, the orchestrator loop, and the
// approval-resolve flow all use exactly the same tool registry and
// policy wiring. Stateless — a new Orchestrator is cheap.

export const buildToolRegistry = (): ToolRegistry => {
  const r = new ToolRegistry();
  r.register(vendorScheduleTool);
  r.register(vendorPurchaseTool);
  return r;
};

export const buildOrchestrator = (db: Db): Orchestrator => {
  const policies = policyRepo(db);
  const actions = actionRepo(db);
  const households = householdRepo(db);
  const tasks = taskRepo(db);
  const approvals = approvalRepo(db);

  return new Orchestrator({
    agents: [householdAgent],
    tools: buildToolRegistry(),
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
    approvals: {
      enqueue: (i) =>
        approvals.create({
          ...i,
          proposedBy: i.proposedBy,
        }),
    },
  });
};

export const buildGraphView = (db: Db, householdId: HouseholdId) => {
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
