import { describe, it, expect } from "vitest";
import {
  Orchestrator,
  ToolRegistry,
  familyAgent,
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

const mkFamilyGraph = (): GraphView => ({
  listNodes: (opts) => {
    const all = [
      { id: "nod_child", type: "person.member", data: { fullName: "Ellie", relationToPrincipal: "child" } },
      { id: "nod_nanny", type: "person.staff", data: { fullName: "Maria", role: "nanny" } },
      {
        id: "nod_grandma",
        type: "person.contact",
        data: { fullName: "Grandma Rose", role: "grandparent" },
      },
    ];
    return opts?.type ? all.filter((n) => n.type === opts.type) : all;
  },
});

const mkCoverageModels = (canned: string): ModelRuntime & { called: number } => {
  let called = 0;
  const runtime: ModelRuntime = {
    callModel: async (_hh, _run, _task, call): Promise<ModelResponse> => {
      called++;
      expect(call.taskClass).toBe("family.coverage_plan");
      return {
        modelCallId: "mcl_1",
        modelId: "test",
        tier: "T2",
        content: canned,
        toolCalls: [],
        usage: {
          inputTokens: 40,
          outputTokens: 40,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          costUsdEstimated: 0.001,
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
  return Object.assign(runtime, {
    get called() {
      return called;
    },
  });
};

describe("family agent — coverage", () => {
  it("proposes coverage assignments and returns them in task outputs", async () => {
    const models = mkCoverageModels(
      JSON.stringify({
        summary: "Coverage draft: 4 routines assigned across 2 caregivers.",
        assignments: [
          { memberRef: "nod_child", personRef: "nod_nanny", personName: "Maria", routine: "Ellie — pickup" },
          { memberRef: "nod_child", personRef: "nod_grandma", personName: "Grandma Rose", routine: "Ellie — dinner" },
        ],
        openQuestions: ["Confirm caregiver availability."],
      }),
    );
    const orch = new Orchestrator({
      agents: [familyAgent],
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
      graph: mkFamilyGraph(),
      writer: mkWriter(),
      intent: {
        kind: "family.coverage.propose",
        subjectPrincipalId: "any_principal",
        attrs: {
          startAt: "2026-10-10T00:00:00.000Z",
          endAt: "2026-10-14T23:59:59.000Z",
          notes: "Board offsite.",
        },
        origin: { source: "customer", by: "test" },
      },
    });
    expect(res.tasks[0]!.state).toBe("completed");
    expect(models.called).toBe(1);
    const outputs = res.tasks[0]!.outputs as {
      plan: {
        summary: string;
        assignments: Array<{ personName: string; routine: string }>;
        openQuestions: string[];
      };
      members: Array<{ id: string; name: string }>;
    };
    expect(outputs.members).toHaveLength(1);
    expect(outputs.plan.assignments).toHaveLength(2);
    expect(outputs.plan.assignments[0]!.personName).toBe("Maria");
    expect(outputs.plan.openQuestions).toHaveLength(1);
  });

  it("escalates when the household has no members", async () => {
    const emptyGraph: GraphView = { listNodes: () => [] };
    const orch = new Orchestrator({
      agents: [familyAgent],
      tools: new ToolRegistry(),
      ledger: mkLedger(),
      policy: mkPolicy(),
      actions: mkRecorder(),
      approvals: mkApprovals(),
      models: {
        callModel: async () => {
          throw new Error("model call should not run when there are no members");
        },
        callModelWithTools: async () => {
          throw new Error("not expected");
        },
      },
    });
    const res = await orch.run({
      householdId: HH,
      actor,
      graph: emptyGraph,
      writer: mkWriter(),
      intent: {
        kind: "family.coverage.propose",
        subjectPrincipalId: "any_principal",
        attrs: {
          startAt: "2026-10-10T00:00:00.000Z",
          endAt: "2026-10-14T23:59:59.000Z",
        },
        origin: { source: "manager", by: "test" },
      },
    });
    expect(res.tasks[0]!.state).toBe("escalated");
  });
});

describe("family agent — school forms", () => {
  it("writes an obligation.deadline candidate for a school form", async () => {
    const writer = mkWriter();
    const orch = new Orchestrator({
      agents: [familyAgent],
      tools: new ToolRegistry(),
      ledger: mkLedger(),
      policy: mkPolicy(),
      actions: mkRecorder(),
      approvals: mkApprovals(),
      models: {
        callModel: async () => {
          throw new Error("model call not expected for form_due");
        },
        callModelWithTools: async () => {
          throw new Error("not expected");
        },
      },
    });
    const res = await orch.run({
      householdId: HH,
      actor,
      graph: mkFamilyGraph(),
      writer,
      intent: {
        kind: "family.school.form_due",
        subjectPrincipalId: "any_principal",
        attrs: {
          memberRef: "nod_child",
          formTitle: "Field trip permission slip",
          dueAt: "2026-10-01T00:00:00.000Z",
        },
        origin: { source: "manager", by: "test" },
      } satisfies Intent,
    });
    expect(res.tasks[0]!.state).toBe("completed");
    expect(writer.written).toHaveLength(1);
    expect(writer.written[0]!.type).toBe("obligation.deadline");
    const data = writer.written[0]!.data;
    expect(String(data["title"])).toContain("Field trip permission slip");
    expect(String(data["title"])).toContain("Ellie");
    expect(String(data["category"])).toBe("school");
  });
});
