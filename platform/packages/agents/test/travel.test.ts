import { describe, it, expect } from "vitest";
import {
  Orchestrator,
  ToolRegistry,
  travelAgent,
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
const mkWriter = (): AgentGraphWriter => ({
  writeNode: () => ({ id: "nod_x" }),
  supersedeNode: () => {},
});

const mkTravelGraph = (opts: {
  passportExpiresAt?: string;
  withMember?: boolean;
} = {}): GraphView => ({
  listNodes: (opts_ = {}) => {
    const nodes: Array<{ id: string; type: string; data: Record<string, unknown> }> = [
      {
        id: "nod_principal",
        type: "person.principal",
        data: { fullName: "Alex Carrington" },
      },
      {
        id: "nod_pref_air",
        type: "preference.travel",
        data: { scope: "airline", value: { airline: "American", tier: "Executive Platinum" } },
      },
    ];
    if (opts.withMember) {
      nodes.push({
        id: "nod_child",
        type: "person.member",
        data: { fullName: "Ellie", relationToPrincipal: "child" },
      });
    }
    if (opts.passportExpiresAt) {
      nodes.push({
        id: "nod_passport",
        type: "document.identity",
        data: {
          title: "Passport — Alex",
          category: "identity",
          expiresAt: opts.passportExpiresAt,
        },
      });
    }
    return opts_.type ? nodes.filter((n) => n.type === opts_.type) : nodes;
  },
});

const mkTravelModels = (canned: string): ModelRuntime & { called: number } => {
  let called = 0;
  const runtime: ModelRuntime = {
    callModel: async (_hh, _run, _task, call): Promise<ModelResponse> => {
      called++;
      expect(["travel.plan.multi", "travel.match"]).toContain(call.taskClass);
      return {
        modelCallId: "mcl_1",
        modelId: "test",
        tier: "T3",
        content: canned,
        toolCalls: [],
        usage: {
          inputTokens: 100,
          outputTokens: 200,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          costUsdEstimated: 0.02,
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

describe("travel agent — trip.plan", () => {
  it("returns a trip plan with flights, hotels, coordination, and no document concerns when passport is valid", async () => {
    const models = mkTravelModels(
      JSON.stringify({
        summary: "Draft plan for London.",
        flights: [{ direction: "outbound", note: "Direct", price: 3500, loyaltyMatch: true }],
        hotels: [{ name: "Boutique", area: "Central London", nightly: 750 }],
        groundTransportation: "Car service.",
        documentNotes: [],
        coordinationNeeds: {
          calendar: "OOO",
          household: "Hold mail.",
          family: "No family coordination required.",
          inbox: "OOO reply.",
        },
        openQuestions: ["Confirm hotel choice."],
      }),
    );
    const orch = new Orchestrator({
      agents: [travelAgent],
      tools: new ToolRegistry(),
      ledger: mkLedger(),
      policy: mkPolicy(),
      actions: mkRecorder(),
      approvals: mkApprovals(),
      models,
    });
    const validExpiry = new Date(
      Date.now() + 3 * 365 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const res = await orch.run({
      householdId: HH,
      actor,
      graph: mkTravelGraph({ passportExpiresAt: validExpiry }),
      writer: mkWriter(),
      intent: {
        kind: "travel.trip.plan",
        subjectPrincipalId: "any_principal",
        attrs: {
          destination: "London, UK",
          startAt: "2026-10-05T00:00:00.000Z",
          endAt: "2026-10-19T00:00:00.000Z",
        },
        origin: { source: "customer", by: "test" },
      },
    });
    expect(res.tasks[0]!.state).toBe("completed");
    expect(models.called).toBe(1);
    const outputs = res.tasks[0]!.outputs as {
      travelers: Array<{ id: string }>;
      documentConcerns: unknown[];
      plan: { flights: unknown[]; hotels: unknown[]; openQuestions: string[] };
    };
    expect(outputs.travelers.some((t) => t.id === "nod_principal")).toBe(true);
    expect(outputs.documentConcerns).toHaveLength(0);
    expect(outputs.plan.flights).toHaveLength(1);
    expect(outputs.plan.hotels).toHaveLength(1);
  });

  it("surfaces a document concern when a passport expires inside the 6-month post-trip window", async () => {
    const models = mkTravelModels(
      JSON.stringify({ summary: "", flights: [], hotels: [] }),
    );
    const orch = new Orchestrator({
      agents: [travelAgent],
      tools: new ToolRegistry(),
      ledger: mkLedger(),
      policy: mkPolicy(),
      actions: mkRecorder(),
      approvals: mkApprovals(),
      models,
    });
    // Trip ends Nov 1; passport expires Feb 15 (~3.5 months later) →
    // inside the 6-month cushion.
    const res = await orch.run({
      householdId: HH,
      actor,
      graph: mkTravelGraph({ passportExpiresAt: "2027-02-15T00:00:00.000Z" }),
      writer: mkWriter(),
      intent: {
        kind: "travel.trip.plan",
        subjectPrincipalId: "any_principal",
        attrs: {
          destination: "London, UK",
          startAt: "2026-10-05T00:00:00.000Z",
          endAt: "2026-11-01T00:00:00.000Z",
        },
        origin: { source: "customer", by: "test" },
      },
    });
    const outputs = res.tasks[0]!.outputs as {
      documentConcerns: Array<{ ref: string }>;
    };
    expect(outputs.documentConcerns).toHaveLength(1);
    expect(outputs.documentConcerns[0]!.ref).toBe("nod_passport");
  });

  it("escalates when no travelers exist in the graph", async () => {
    const emptyGraph: GraphView = { listNodes: () => [] };
    const orch = new Orchestrator({
      agents: [travelAgent],
      tools: new ToolRegistry(),
      ledger: mkLedger(),
      policy: mkPolicy(),
      actions: mkRecorder(),
      approvals: mkApprovals(),
      models: {
        callModel: async () => {
          throw new Error("model call should not run when no travelers");
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
        kind: "travel.trip.plan",
        subjectPrincipalId: "any_principal",
        attrs: {
          destination: "London, UK",
          startAt: "2026-10-05T00:00:00.000Z",
          endAt: "2026-10-19T00:00:00.000Z",
        },
        origin: { source: "manager", by: "test" },
      } satisfies Intent,
    });
    expect(res.tasks[0]!.state).toBe("escalated");
  });
});
