import { describe, it, expect } from "vitest";
import type {
  ActionOutcome,
  HouseholdId,
  PolicyDecision,
  PolicyId,
} from "@atelier/domain";
import {
  Orchestrator,
  ToolRegistry,
  householdAgent,
  vendorScheduleTool,
  type Intent,
  type TaskLedger,
  type PolicyRuntime,
  type ActionRecorder,
  type ApprovalSink,
  type GraphView,
} from "../src/index.js";

const HH = "hh_test" as HouseholdId;

const mkLedger = (): TaskLedger & { runs: Map<string, unknown>; tasks: Map<string, Record<string, unknown>> } => {
  const runs = new Map<string, unknown>();
  const tasks = new Map<string, Record<string, unknown>>();
  let n = 0;
  const nextId = (p: string) => `${p}_${++n}`;
  return {
    runs,
    tasks,
    startRun: (i) => {
      const id = nextId("run");
      runs.set(id, { ...i, state: "running" });
      return { id };
    },
    finishRun: (id, state) => {
      const existing = (runs.get(id) as Record<string, unknown>) ?? {};
      runs.set(id, { ...existing, state });
    },
    createTask: (i) => {
      const id = nextId("tsk");
      tasks.set(id, { ...i, state: "received" });
      return { id };
    },
    updateTask: (id, u) => {
      tasks.set(id, { ...(tasks.get(id) ?? {}), ...u });
    },
    listTasksForRun: (runId) =>
      Array.from(tasks.entries())
        .filter(([, t]) => t["runId"] === runId)
        .map(([id, t]) => ({
          id,
          agent: t["agent"] as string,
          kind: t["kind"] as string,
          state: t["state"] as string,
          decisionSummary: t["decisionSummary"] as string | undefined,
          outputs: t["outputs"],
          errorMessage: t["errorMessage"] as string | undefined,
        })),
  };
};

const mkPolicy = (decision: Partial<PolicyDecision> = {}): PolicyRuntime => ({
  evaluate: (): PolicyDecision => ({
    decision: "auto_execute",
    requiredRung: "execute",
    authorityId: "pol_test" as PolicyId,
    approver: undefined,
    reasons: [],
    policiesChecked: [],
    evaluatedAt: new Date().toISOString(),
    ...decision,
  }),
});

const mkRecorder = (): ActionRecorder & { recorded: unknown[] } => {
  const recorded: unknown[] = [];
  let n = 0;
  return {
    recorded,
    record: (i) => {
      recorded.push(i);
      return { id: `act_${++n}` };
    },
  };
};

const mkApprovals = (): ApprovalSink & { queued: unknown[] } => {
  const queued: unknown[] = [];
  let n = 0;
  return {
    queued,
    enqueue: (i) => {
      queued.push(i);
      return { id: `apr_${++n}` };
    },
  };
};

const mkGraph = (nodes: Array<{ id: string; type: string; data: Record<string, unknown> }> = []): GraphView => ({
  listNodes: (opts) => (opts?.type ? nodes.filter((n) => n.type === opts.type) : nodes),
});

const mkTools = (): ToolRegistry => {
  const r = new ToolRegistry();
  r.register(vendorScheduleTool);
  return r;
};

const scheduleIntent: Intent = {
  kind: "household.vendor.schedule",
  subjectPrincipalId: "any_principal",
  attrs: { propertyNodeId: "nod_home", serviceType: "HVAC" },
  origin: { source: "customer", by: "test" },
};

const actor = { type: "manager" as const, id: "mgr_test", displayName: "Test" };

describe("orchestrator + household agent + vendor tool", () => {
  it("routes to household agent, invokes tool, records action", async () => {
    const ledger = mkLedger();
    const recorder = mkRecorder();
    const graph = mkGraph([
      { id: "nod_acme", type: "org.vendor", data: { name: "Acme HVAC", notes: "hvac quarterly" } },
    ]);
    const orch = new Orchestrator({
      agents: [householdAgent],
      tools: mkTools(),
      ledger,
      policy: mkPolicy(),
      actions: recorder,
      approvals: mkApprovals(),
    });

    const res = await orch.run({ householdId: HH, actor, graph, intent: scheduleIntent });

    expect(res.state).toBe("completed");
    expect(res.tasks).toHaveLength(1);
    expect(res.tasks[0]!.state).toBe("completed");
    expect(recorder.recorded).toHaveLength(1);
    const action = recorder.recorded[0] as { policyIdAuthorizing?: string; outcome: string };
    expect(action.outcome).toBe("succeeded");
    expect(action.policyIdAuthorizing).toBe("pol_test");
  });

  it("escalates when no vendor is known", async () => {
    const ledger = mkLedger();
    const recorder = mkRecorder();
    const graph = mkGraph([]);
    const orch = new Orchestrator({
      agents: [householdAgent],
      tools: mkTools(),
      ledger,
      policy: mkPolicy(),
      actions: recorder,
      approvals: mkApprovals(),
    });

    const res = await orch.run({ householdId: HH, actor, graph, intent: scheduleIntent });

    expect(res.state).toBe("completed");
    expect(res.tasks[0]!.state).toBe("escalated");
    expect(recorder.recorded).toHaveLength(0);
  });

  it("marks the task shelved when the household is frozen", async () => {
    const ledger = mkLedger();
    const recorder = mkRecorder();
    const graph = mkGraph([
      { id: "nod_acme", type: "org.vendor", data: { name: "Acme", notes: "hvac" } },
    ]);
    const orch = new Orchestrator({
      agents: [householdAgent],
      tools: mkTools(),
      ledger,
      policy: mkPolicy({
        decision: "shelved",
        requiredRung: "observe",
        authorityId: undefined,
        reasons: ["household_frozen"],
      }),
      actions: recorder,
      approvals: mkApprovals(),
    });

    const res = await orch.run({ householdId: HH, actor, graph, intent: scheduleIntent });

    expect(res.tasks[0]!.state).toBe("shelved");
    expect(recorder.recorded).toHaveLength(0);
  });

  it("escalates and enqueues an approval when policy requires ask", async () => {
    const ledger = mkLedger();
    const recorder = mkRecorder();
    const approvals = mkApprovals();
    const graph = mkGraph([
      { id: "nod_acme", type: "org.vendor", data: { name: "Acme", notes: "hvac" } },
    ]);
    const orch = new Orchestrator({
      agents: [householdAgent],
      tools: mkTools(),
      ledger,
      policy: mkPolicy({
        decision: "customer_approval",
        requiredRung: "ask",
        approver: { type: "manager" },
      }),
      actions: recorder,
      approvals,
    });

    const res = await orch.run({ householdId: HH, actor, graph, intent: scheduleIntent });

    expect(res.tasks[0]!.state).toBe("escalated");
    expect(recorder.recorded).toHaveLength(0);
    expect(approvals.queued).toHaveLength(1);
  });

  it("fails when no agent handles the intent", async () => {
    const ledger = mkLedger();
    const orch = new Orchestrator({
      agents: [householdAgent],
      tools: mkTools(),
      ledger,
      policy: mkPolicy(),
      actions: mkRecorder(),
      approvals: mkApprovals(),
    });

    const res = await orch.run({
      householdId: HH,
      actor,
      graph: mkGraph(),
      intent: { ...scheduleIntent, kind: "travel.flight.book" },
    });

    expect(res.state).toBe("failed");
  });
});
