import { describe, it, expect } from "vitest";
import {
  Orchestrator,
  ToolRegistry,
  calendarAgent,
  calendarCreateTool,
  householdAgent,
  vendorScheduleTool,
  parsePlan,
  pickPlannerTaskClass,
  plannerSystemPrompt,
  isKnownIntentKind,
  type ActionRecorder,
  type AgentGraphWriter,
  type ApprovalSink,
  type GraphView,
  type ModelRuntime,
  type PolicyRuntime,
  type TaskLedger,
} from "../src/index.js";
import type { HouseholdId, ModelResponse, PolicyDecision } from "@atelier/domain";

describe("planner utilities", () => {
  it("emits a system prompt that enumerates the registered kinds", () => {
    const p = plannerSystemPrompt();
    expect(p).toContain("household.vendor.schedule");
    expect(p).toContain("calendar.appointment.create");
    expect(p).toContain("inbox.message.process");
  });

  it("picks orchestrator.simple for a short single-domain prompt", () => {
    expect(pickPlannerTaskClass("Please book HVAC service")).toBe("orchestrator.simple");
  });

  it("picks orchestrator.cross_domain for prompts touching multiple domains", () => {
    expect(
      pickPlannerTaskClass(
        "We're going to London for two weeks in October. Please handle flight, hotel, school and reply.",
      ),
    ).toBe("orchestrator.cross_domain");
  });

  it("parses a plan tolerating extra prose around the JSON", () => {
    const raw =
      'Sure — here is the plan.\n{"reasoning":"vendor + calendar","intents":[{"kind":"household.vendor.schedule","attrs":{"propertyNodeId":"nod_home","serviceType":"HVAC"}}]}';
    const plan = parsePlan(raw);
    expect(plan.intents).toHaveLength(1);
    expect(plan.intents[0]!.kind).toBe("household.vendor.schedule");
    expect(isKnownIntentKind(plan.intents[0]!.kind)).toBe(true);
  });

  it("returns an empty plan when the model output is unparseable", () => {
    const plan = parsePlan("could not comply");
    expect(plan.intents).toHaveLength(0);
  });
});

// End-to-end planner → run test with mocked deps.

const HH = "hh_test" as HouseholdId;
const actor = { type: "manager" as const, id: "mgr_test", displayName: "Test" };

const mkLedger = (): TaskLedger => {
  const tasks = new Map<string, Record<string, unknown>>();
  let n = 0;
  return {
    startRun: (i) => {
      const id = `run_${++n}`;
      tasks.set(id, { ...i, state: "running" });
      return { id };
    },
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

const mkRecorder = (): ActionRecorder & { recorded: unknown[] } => {
  const recorded: unknown[] = [];
  let n = 0;
  return { recorded, record: (i) => { recorded.push(i); return { id: `act_${++n}` }; } };
};

const mkApprovals = (): ApprovalSink => ({
  enqueue: () => ({ id: "apr_test" }),
});

const mkWriter = (): AgentGraphWriter => {
  let n = 0;
  return {
    writeNode: () => ({ id: `nod_${++n}` }),
    supersedeNode: () => {},
  };
};

const mkGraph = (): GraphView => ({
  listNodes: () => [
    { id: "nod_acme", type: "org.vendor", data: { name: "Acme", notes: "hvac quarterly" } },
  ],
});

const mkPlannerModels = (canned: string): ModelRuntime => ({
  callModel: async (_hh, _run, _task, call): Promise<ModelResponse> => ({
    modelCallId: "mcl_plan",
    modelId: "test-planner",
    tier: "T2",
    content:
      call.taskClass.startsWith("orchestrator.") ? canned : "irrelevant",
    toolCalls: [],
    usage: {
      inputTokens: 10,
      outputTokens: 10,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      costUsdEstimated: 0.0001,
    },
    latencyMs: 1,
    finishReason: "stop",
    reasons: [],
  }),
  callModelWithTools: async () => {
    throw new Error("callModelWithTools not expected in these tests");
  },
});

describe("Orchestrator.planAndRun", () => {
  it("plans and dispatches a single-domain HVAC request", async () => {
    const canned = JSON.stringify({
      reasoning: "hvac scheduling",
      intents: [
        {
          kind: "household.vendor.schedule",
          attrs: { propertyNodeId: "nod_home", serviceType: "HVAC" },
        },
      ],
    });
    const recorder = mkRecorder();
    const tools = new ToolRegistry();
    tools.register(vendorScheduleTool);
    const orch = new Orchestrator({
      agents: [householdAgent],
      tools,
      ledger: mkLedger(),
      policy: mkPolicy(),
      actions: recorder,
      approvals: mkApprovals(),
      models: mkPlannerModels(canned),
    });
    const res = await orch.planAndRun({
      householdId: HH,
      actor,
      graph: mkGraph(),
      writer: mkWriter(),
      prompt: "Please book quarterly HVAC service.",
      origin: { source: "customer", by: "test" },
    });
    expect(res.plan.intents).toHaveLength(1);
    expect(res.runs).toHaveLength(1);
    expect(res.runs[0]!.tasks[0]!.state).toBe("completed");
    expect(recorder.recorded).toHaveLength(1);
  });

  it("plans a cross-domain prompt and runs each intent", async () => {
    const canned = JSON.stringify({
      reasoning: "two things",
      intents: [
        {
          kind: "household.vendor.schedule",
          attrs: { propertyNodeId: "nod_home", serviceType: "HVAC" },
        },
        {
          kind: "calendar.appointment.create",
          attrs: {
            title: "Confirm with contractor",
            startAt: "2026-10-01T15:00:00.000Z",
            endAt: "2026-10-01T15:15:00.000Z",
          },
        },
      ],
    });
    const recorder = mkRecorder();
    const tools = new ToolRegistry();
    tools.register(vendorScheduleTool);
    tools.register(calendarCreateTool);
    const orch = new Orchestrator({
      agents: [householdAgent, calendarAgent],
      tools,
      ledger: mkLedger(),
      policy: mkPolicy(),
      actions: recorder,
      approvals: mkApprovals(),
      models: mkPlannerModels(canned),
    });
    const res = await orch.planAndRun({
      householdId: HH,
      actor,
      graph: mkGraph(),
      writer: mkWriter(),
      prompt:
        "Book quarterly HVAC service and put a 15-minute confirmation call on my calendar.",
      origin: { source: "customer", by: "test" },
    });
    expect(res.runs).toHaveLength(2);
    for (const r of res.runs) expect(r.tasks[0]!.state).toBe("completed");
  });
});
