import { describe, it, expect } from "vitest";
import {
  Orchestrator,
  ToolRegistry,
  adminAgent,
  type ActionRecorder,
  type AgentGraphWriter,
  type ApprovalSink,
  type GraphView,
  type Intent,
  type ModelRuntime,
  type PolicyRuntime,
  type TaskLedger,
} from "../src/index.js";
import type { HouseholdId, ModelResponse, PolicyDecision } from "@atelier/domain";

const HH = "hh_test" as HouseholdId;
const actor = { type: "manager" as const, id: "mgr_test", displayName: "Test" };

const mkLedger = (): TaskLedger => {
  const tasks = new Map<string, Record<string, unknown>>();
  let n = 0;
  return {
    startRun: () => ({ id: `run_${++n}` }),
    finishRun: () => {},
    createTask: (i) => {
      const id = `tsk_${++n}`;
      tasks.set(id, { ...i, state: "received" });
      return { id };
    },
    updateTask: (id, u) => tasks.set(id, { ...(tasks.get(id) ?? {}), ...u }),
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

const mkPolicy = (): PolicyRuntime => ({
  evaluate: (): PolicyDecision => ({
    decision: "auto_execute",
    requiredRung: "execute",
    authorityId: "pol_test" as never,
    approver: undefined,
    reasons: [],
    policiesChecked: [],
    evaluatedAt: new Date().toISOString(),
  }),
});

const mkRecorder = (): ActionRecorder => ({ record: () => ({ id: "act_x" }) });
const mkApprovals = (): ApprovalSink => ({ enqueue: () => ({ id: "apr_x" }) });
const mkWriter = (): AgentGraphWriter & { written: Array<{ type: string; data: Record<string, unknown> }> } => {
  const written: Array<{ type: string; data: Record<string, unknown> }> = [];
  let n = 0;
  return {
    written,
    writeNode: (input) => {
      written.push({ type: input.type, data: input.data });
      return { id: `nod_${++n}` };
    },
    supersedeNode: () => {},
  };
};

const inDays = (n: number): string =>
  new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();

const mkGraph = (): GraphView => ({
  listNodes: (opts) => {
    const all = [
      {
        id: "nod_passport",
        type: "document.identity",
        data: {
          title: "Passport — Principal",
          category: "identity",
          expiresAt: inDays(20),
        },
      },
      {
        id: "nod_home_policy",
        type: "document.policy",
        data: {
          title: "Homeowners insurance",
          category: "policy",
          expiresAt: inDays(10),
        },
      },
      {
        id: "nod_far_future",
        type: "document.policy",
        data: {
          title: "Umbrella policy",
          category: "policy",
          expiresAt: inDays(200),
        },
      },
      {
        id: "nod_vendor",
        type: "org.vendor",
        data: { name: "Acme" },
      },
    ];
    return opts?.type ? all.filter((n) => n.type === opts.type) : all;
  },
});

const mkAdminModels = (): ModelRuntime & { called: number } => {
  const state = { called: 0 };
  const runtime: ModelRuntime = {
    callModel: async (_hh, _run, _task, call): Promise<ModelResponse> => {
      state.called++;
      expect(call.taskClass).toBe("admin.renewal.detect");
      const userMsg = call.messages.find((m) => m.role === "user")?.content ?? "";
      const parsed = JSON.parse(userMsg) as {
        items: Array<{ id: string; daysUntilExpiry: number }>;
      };
      const content = JSON.stringify({
        summary: `${parsed.items.length} items nearing expiry.`,
        items: parsed.items.map((i) => ({
          id: i.id,
          urgency: i.daysUntilExpiry < 15 ? "high" : "normal",
          recommendedAction: `Renew item ${i.id}`,
        })),
      });
      return {
        modelCallId: "mcl_1",
        modelId: "test",
        tier: "T1",
        content,
        toolCalls: [],
        usage: {
          inputTokens: 40,
          outputTokens: 30,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          costUsdEstimated: 0.0001,
        },
        latencyMs: 5,
        finishReason: "stop",
        reasons: [],
      };
    },
    callModelWithTools: async () => {
      throw new Error("callModelWithTools not expected");
    },
  };
  // Object.assign copies value descriptors, not accessors — a
  // getter defined here would be evaluated once and frozen at 0.
  // Use Object.defineProperty so `models.called` reads through to
  // the live counter each time the test asserts it.
  return Object.defineProperty(runtime, "called", {
    enumerable: true,
    get: () => state.called,
  }) as ModelRuntime & { called: number };
};

const reviewIntent: Intent = {
  kind: "admin.renewals.review",
  subjectPrincipalId: "any_principal",
  attrs: {},
  origin: { source: "manager", by: "test" },
};

describe("admin agent", () => {
  it("classifies expiring documents in one batch call and writes follow-up obligations", async () => {
    const writer = mkWriter();
    const models = mkAdminModels();
    const orch = new Orchestrator({
      agents: [adminAgent],
      tools: new ToolRegistry(),
      ledger: mkLedger(),
      policy: mkPolicy(),
      actions: mkRecorder(),
      approvals: mkApprovals(),
      models,
    });
    const res = await orch.run({
      householdId: HH,
      actor,
      graph: mkGraph(),
      writer,
      intent: reviewIntent,
    });
    expect(res.tasks[0]!.state).toBe("completed");
    expect(models.called).toBe(1);

    const outputs = res.tasks[0]!.outputs as {
      expiring: Array<{ id: string; urgency: string; recommendedAction: string }>;
      obligationIdsWritten: string[];
    };
    // 45-day window; only passport (20d) and home policy (10d) qualify.
    // Umbrella at 200d is out of window.
    expect(outputs.expiring.map((e) => e.id).sort()).toEqual([
      "nod_home_policy",
      "nod_passport",
    ]);
    // Home policy at 10 days should be marked urgent.
    const homeExpiring = outputs.expiring.find((e) => e.id === "nod_home_policy");
    expect(homeExpiring?.urgency).toBe("high");
    expect(outputs.obligationIdsWritten).toHaveLength(2);
    expect(writer.written).toHaveLength(2);
    expect(writer.written.every((w) => w.type === "obligation.deadline")).toBe(true);
  });

  it("returns cleanly with zero writes when nothing is expiring", async () => {
    const writer = mkWriter();
    const emptyGraph: GraphView = { listNodes: () => [] };
    const orch = new Orchestrator({
      agents: [adminAgent],
      tools: new ToolRegistry(),
      ledger: mkLedger(),
      policy: mkPolicy(),
      actions: mkRecorder(),
      approvals: mkApprovals(),
      models: {
        callModel: async () => {
          throw new Error("model call not expected when there is nothing to classify");
        },
        callModelWithTools: async () => {
          throw new Error("callModelWithTools not expected");
        },
      },
    });
    const res = await orch.run({
      householdId: HH,
      actor,
      graph: emptyGraph,
      writer,
      intent: reviewIntent,
    });
    expect(res.tasks[0]!.state).toBe("completed");
    expect(writer.written).toHaveLength(0);
  });
});
