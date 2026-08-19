import {
  Orchestrator,
  ToolRegistry,
  householdAgent,
  calendarAgent,
  inboxAgent,
  researchAgent,
  adminAgent,
  vendorScheduleTool,
  vendorPurchaseTool,
  calendarCreateTool,
  calendarRescheduleTool,
  messageSendTool,
  type AgentGraphWriter,
} from "@atelier/agents";
import {
  actionRepo,
  approvalRepo,
  graphRepo,
  householdRepo,
  modelCallRepo,
  policyRepo,
  taskRepo,
  type Db,
} from "@atelier/db";
import { evaluate as evaluatePolicy } from "@atelier/policy";
import { ModelRegistry, Router, callModel, callModelWithTools } from "@atelier/router";
import {
  isKnownNodeType,
  nowIso,
  type ActionRequest,
  type HouseholdId,
  type HouseholdRiskTier,
  type ModelCall,
  type ModelResponse,
  type NodeId,
  type NodeType,
} from "@atelier/domain";

// One process-wide registry and router. Both are stateless — the
// registry's shape is code today, and the router is pure logic over
// its inputs. Swapping to a config-driven registry later slots in
// here without touching the runtime factory below.
const REGISTRY = new ModelRegistry();
const ROUTER = new Router(REGISTRY);

// Per-household inference budget by subscription tier — Phase 0
// heuristic. Real numbers come from the pricing model; these are
// deliberately conservative so the router surfaces "approaching" /
// "over" in demo scenarios.
const MONTHLY_INFERENCE_BUDGET_USD: Record<string, number> = {
  life: 25,
  executive: 60,
  private: 150,
};

export const getRegistry = (): ModelRegistry => REGISTRY;
export const getRouter = (): Router => ROUTER;

export const buildToolRegistry = (): ToolRegistry => {
  const r = new ToolRegistry();
  r.register(vendorScheduleTool);
  r.register(vendorPurchaseTool);
  r.register(calendarCreateTool);
  r.register(calendarRescheduleTool);
  r.register(messageSendTool);
  return r;
};

const budgetStatus = (spent: number, cap: number): "under" | "approaching" | "over" => {
  if (cap <= 0) return "under";
  const ratio = spent / cap;
  if (ratio >= 1) return "over";
  if (ratio >= 0.8) return "approaching";
  return "under";
};

export const buildOrchestrator = (db: Db): Orchestrator => {
  const policies = policyRepo(db);
  const actions = actionRepo(db);
  const households = householdRepo(db);
  const tasks = taskRepo(db);
  const approvals = approvalRepo(db);
  const modelCalls = modelCallRepo(db);

  const householdCache = new Map<
    string,
    { riskTier: HouseholdRiskTier; cap: number }
  >();
  const loadHousehold = (id: HouseholdId) => {
    const cached = householdCache.get(id);
    if (cached) return cached;
    const hh = households.get(id);
    if (!hh) throw new Error(`household not found: ${id}`);
    const rec = {
      riskTier: hh.riskTier,
      cap: MONTHLY_INFERENCE_BUDGET_USD[hh.tier] ?? 25,
    };
    householdCache.set(id, rec);
    return rec;
  };

  return new Orchestrator({
    agents: [householdAgent, calendarAgent, inboxAgent, researchAgent, adminAgent],
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
    actions: { record: (i) => actions.record(i) },
    approvals: {
      enqueue: (i) => approvals.create({ ...i, proposedBy: i.proposedBy }),
    },
    models: {
      callModel: async (
        householdId: HouseholdId,
        runId: string,
        taskId: string,
        call: ModelCall,
      ): Promise<ModelResponse> => {
        return callModel(
          modelDeps(),
          call,
          {
            householdId,
            triggeringRunId: runId,
            triggeringTaskId: taskId,
          },
        );
      },
      callModelWithTools: async (householdId, runId, taskId, call, opts) => {
        const res = await callModelWithTools(
          modelDeps(),
          call,
          {
            householdId,
            triggeringRunId: runId,
            triggeringTaskId: taskId,
            handleToolUse: opts.handleToolUse,
            ...(opts.maxTurns !== undefined && { maxTurns: opts.maxTurns }),
          },
        );
        return {
          finalContent: res.final.content,
          finalToolCalls: res.final.toolCalls,
          turns: res.turns.length,
          totalInputTokens: res.totalInputTokens,
          totalOutputTokens: res.totalOutputTokens,
          totalCachedInputTokens: res.totalCachedInputTokens,
          totalCostUsdEstimated: res.totalCostUsdEstimated,
        };
      },
    },
  });

  function modelDeps() {
    return {
      router: ROUTER,
      recorder: { record: (i: Parameters<typeof modelCalls.record>[0]) => modelCalls.record(i) },
      budget: {
        status: (h: HouseholdId) => {
          const { cap } = loadHousehold(h);
          const rollup = modelCalls.rollup(h, 30);
          return budgetStatus(rollup.totalUsd, cap);
        },
        riskTier: (h: HouseholdId) => loadHousehold(h).riskTier,
      },
    };
  }
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

export const buildGraphWriter = (
  db: Db,
  householdId: HouseholdId,
  assertedBy: string,
): AgentGraphWriter => {
  const graph = graphRepo(db);
  return {
    writeNode: (input) => {
      if (!isKnownNodeType(input.type)) {
        throw new Error(`Unknown node type: ${input.type}`);
      }
      const node = graph.createNode(householdId, {
        type: input.type as NodeType,
        data: input.data,
        provenance: {
          source: "agent_inferred_action_outcome",
          assertedBy,
          assertedAt: nowIso(),
          confidence: input.confidence ?? 0.9,
          status: input.status ?? "candidate",
          ...(input.sourceRef !== undefined && { sourceRef: input.sourceRef }),
        },
      });
      return { id: node.id };
    },
    supersedeNode: (nodeId, replacementId) => {
      graph.supersedeNode(
        householdId,
        nodeId as NodeId,
        replacementId as NodeId | undefined,
      );
    },
  };
};

export const inferenceBudgetFor = (
  db: Db,
  householdId: HouseholdId,
): { totalUsd: number; totalCalls: number; capUsd: number; status: "under" | "approaching" | "over"; byTier: Record<string, { calls: number; usd: number }> } => {
  const households = householdRepo(db);
  const hh = households.get(householdId);
  const cap =
    hh && MONTHLY_INFERENCE_BUDGET_USD[hh.tier] !== undefined
      ? MONTHLY_INFERENCE_BUDGET_USD[hh.tier]!
      : 25;
  const rollup = modelCallRepo(db).rollup(householdId, 30);
  return {
    totalUsd: rollup.totalUsd,
    totalCalls: rollup.totalCalls,
    capUsd: cap,
    status: budgetStatus(rollup.totalUsd, cap),
    byTier: rollup.byTier,
  };
};
