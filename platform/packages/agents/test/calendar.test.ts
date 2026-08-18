import { describe, it, expect } from "vitest";
import {
  Orchestrator,
  ToolRegistry,
  calendarAgent,
  calendarCreateTool,
  calendarRescheduleTool,
  type ActionRecorder,
  type AgentGraphWriter,
  type ApprovalSink,
  type GraphView,
  type Intent,
  type ModelRuntime,
  type PolicyRuntime,
  type TaskLedger,
} from "../src/index.js";
import type { HouseholdId, PolicyDecision } from "@atelier/domain";

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

const mkPolicy = (
  by: (actionClass: string, attrs: Record<string, unknown>) => Partial<PolicyDecision>,
): PolicyRuntime => ({
  evaluate: (_hh, req) => ({
    decision: "auto_execute",
    requiredRung: "execute",
    authorityId: "pol_test" as never,
    approver: undefined,
    reasons: [],
    policiesChecked: [],
    evaluatedAt: new Date().toISOString(),
    ...by(req.actionClass, req.attrs),
  }),
});

const mkRecorder = (): ActionRecorder & { recorded: unknown[] } => {
  const recorded: unknown[] = [];
  let n = 0;
  return { recorded, record: (i) => { recorded.push(i); return { id: `act_${++n}` }; } };
};

const mkApprovals = (): ApprovalSink & { queued: unknown[] } => {
  const queued: unknown[] = [];
  let n = 0;
  return { queued, enqueue: (i) => { queued.push(i); return { id: `apr_${++n}` }; } };
};

const mkModels = (): ModelRuntime => ({
  callModel: async () => {
    throw new Error("model calls not expected in these tests");
  },
  callModelWithTools: async () => {
    throw new Error("callModelWithTools not expected in these tests");
  },
});

const mkWriter = (): AgentGraphWriter & { written: Array<{ type: string; data: Record<string, unknown> }>; superseded: string[] } => {
  const written: Array<{ type: string; data: Record<string, unknown> }> = [];
  const superseded: string[] = [];
  let n = 0;
  return {
    written,
    superseded,
    writeNode: (input) => {
      written.push({ type: input.type, data: input.data });
      return { id: `nod_${++n}` };
    },
    supersedeNode: (id) => { superseded.push(id); },
  };
};

const mkGraph = (
  nodes: Array<{ id: string; type: string; data: Record<string, unknown> }> = [],
): GraphView => ({
  listNodes: (opts) => (opts?.type ? nodes.filter((n) => n.type === opts.type) : nodes),
});

const mkTools = () => {
  const r = new ToolRegistry();
  r.register(calendarCreateTool);
  r.register(calendarRescheduleTool);
  return r;
};

const createIntent: Intent = {
  kind: "calendar.appointment.create",
  subjectPrincipalId: "any_principal",
  attrs: {
    title: "Board meeting",
    startAt: "2026-09-01T15:00:00.000Z",
    endAt: "2026-09-01T16:00:00.000Z",
  },
  origin: { source: "manager", by: "test" },
};

describe("calendar agent", () => {
  it("creates an appointment when no conflicts and writes it back to the graph", async () => {
    const recorder = mkRecorder();
    const writer = mkWriter();
    const orch = new Orchestrator({
      agents: [calendarAgent],
      tools: mkTools(),
      ledger: mkLedger(),
      policy: mkPolicy(() => ({})),
      actions: recorder,
      approvals: mkApprovals(),
      models: mkModels(),
    });
    const res = await orch.run({
      householdId: HH,
      actor,
      graph: mkGraph(),
      writer,
      intent: createIntent,
    });
    expect(res.state).toBe("completed");
    expect(res.tasks[0]!.state).toBe("completed");
    expect(recorder.recorded).toHaveLength(1);
    expect(writer.written).toHaveLength(1);
    expect(writer.written[0]!.type).toBe("obligation.appointment");
    expect(writer.written[0]!.data["title"]).toBe("Board meeting");
  });

  it("escalates on conflict without invoking the tool", async () => {
    const recorder = mkRecorder();
    const writer = mkWriter();
    const orch = new Orchestrator({
      agents: [calendarAgent],
      tools: mkTools(),
      ledger: mkLedger(),
      policy: mkPolicy(() => ({})),
      actions: recorder,
      approvals: mkApprovals(),
      models: mkModels(),
    });
    const res = await orch.run({
      householdId: HH,
      actor,
      graph: mkGraph([
        {
          id: "nod_existing",
          type: "obligation.appointment",
          data: {
            title: "Standing 1:1",
            startAt: "2026-09-01T15:30:00.000Z",
            endAt: "2026-09-01T15:45:00.000Z",
          },
        },
      ]),
      writer,
      intent: createIntent,
    });
    expect(res.tasks[0]!.state).toBe("escalated");
    expect(recorder.recorded).toHaveLength(0);
    expect(writer.written).toHaveLength(0);
  });

  it("reschedules an appointment same-day and supersedes the old node", async () => {
    const recorder = mkRecorder();
    const writer = mkWriter();
    const orch = new Orchestrator({
      agents: [calendarAgent],
      tools: mkTools(),
      ledger: mkLedger(),
      policy: mkPolicy(() => ({})),
      actions: recorder,
      approvals: mkApprovals(),
      models: mkModels(),
    });
    const res = await orch.run({
      householdId: HH,
      actor,
      graph: mkGraph([
        {
          id: "nod_meet",
          type: "obligation.appointment",
          data: {
            title: "Board meeting",
            startAt: "2026-09-01T15:00:00.000Z",
            endAt: "2026-09-01T16:00:00.000Z",
            eventRef: "existing-ref",
          },
        },
      ]),
      writer,
      intent: {
        kind: "calendar.appointment.reschedule",
        subjectPrincipalId: "any_principal",
        attrs: {
          appointmentNodeId: "nod_meet",
          toStartAt: "2026-09-01T18:00:00.000Z",
          toEndAt: "2026-09-01T19:00:00.000Z",
        },
        origin: { source: "manager", by: "test" },
      },
    });
    expect(res.tasks[0]!.state).toBe("completed");
    expect(writer.written).toHaveLength(1);
    expect(writer.superseded).toEqual(["nod_meet"]);
  });

  it("cross-day reschedule escalates to approval when policy asks for it", async () => {
    const recorder = mkRecorder();
    const approvals = mkApprovals();
    const orch = new Orchestrator({
      agents: [calendarAgent],
      tools: mkTools(),
      ledger: mkLedger(),
      policy: mkPolicy((actionClass, attrs) => {
        if (actionClass === "calendar.reshuffle" && attrs["cross_day"] === true) {
          return {
            decision: "customer_approval",
            requiredRung: "ask",
            approver: { type: "manager" },
          };
        }
        return {};
      }),
      actions: recorder,
      approvals,
      models: mkModels(),
    });
    const res = await orch.run({
      householdId: HH,
      actor,
      graph: mkGraph([
        {
          id: "nod_meet",
          type: "obligation.appointment",
          data: {
            title: "Board meeting",
            startAt: "2026-09-01T15:00:00.000Z",
            endAt: "2026-09-01T16:00:00.000Z",
          },
        },
      ]),
      writer: mkWriter(),
      intent: {
        kind: "calendar.appointment.reschedule",
        subjectPrincipalId: "any_principal",
        attrs: {
          appointmentNodeId: "nod_meet",
          toStartAt: "2026-09-05T15:00:00.000Z",
          toEndAt: "2026-09-05T16:00:00.000Z",
        },
        origin: { source: "manager", by: "test" },
      },
    });
    expect(res.tasks[0]!.state).toBe("escalated");
    expect(recorder.recorded).toHaveLength(0);
    expect(approvals.queued).toHaveLength(1);
  });
});
