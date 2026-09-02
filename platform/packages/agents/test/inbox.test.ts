import { describe, it, expect } from "vitest";
import {
  Orchestrator,
  ToolRegistry,
  inboxAgent,
  messageSendTool,
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

const mkPolicy = (customize?: (attrs: Record<string, unknown>) => Partial<PolicyDecision>): PolicyRuntime => ({
  evaluate: (_hh, req) => ({
    decision: "manager_review",
    requiredRung: "draft",
    authorityId: "pol_send" as never,
    approver: { type: "manager" },
    reasons: ["default_message_send_policy"],
    policiesChecked: [],
    evaluatedAt: new Date().toISOString(),
    ...(customize?.(req.attrs) ?? {}),
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

const mkGraph = (): GraphView => ({ listNodes: () => [] });

const mkModels = (byTask: Record<string, string>): ModelRuntime & { calls: string[] } => {
  const calls: string[] = [];
  const runtime: ModelRuntime = {
    callModel: async (_hh, _run, _task, call) => {
      calls.push(call.taskClass);
      const content = byTask[call.taskClass] ?? `mock:${call.taskClass}`;
      const resp: ModelResponse = {
        modelCallId: `mcl_${calls.length}`,
        modelId: "test-model",
        tier: "T1",
        content,
        toolCalls: [],
        usage: {
          inputTokens: 10,
          outputTokens: 10,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          costUsdEstimated: 0.0001,
        },
        latencyMs: 5,
        finishReason: "stop",
        reasons: [],
      };
      return resp;
    },
    callModelWithTools: async () => {
      throw new Error("callModelWithTools not expected in these tests");
    },
  };
  return Object.assign(runtime, { calls });
};

const mkTools = () => {
  const r = new ToolRegistry();
  r.register(messageSendTool);
  return r;
};

const inboxIntent: Intent = {
  kind: "inbox.message.process",
  subjectPrincipalId: "any_principal",
  attrs: {
    messageId: "msg_test",
    fromName: "Sam",
    fromAddress: "sam@example.com",
    subject: "Fence estimate",
    body: "Estimate is $1,850. Please confirm by Friday.",
  },
  origin: { source: "manager", by: "test" },
};

describe("inbox agent", () => {
  it("triages, extracts obligations, drafts a reply, and queues an approval", async () => {
    const models = mkModels({
      "inbox.triage": JSON.stringify({
        urgency: "normal",
        recipientClass: "vendor",
        requiresReply: "yes",
      }),
      "inbox.extract": JSON.stringify({
        obligations: [{ title: "Reply to Sam by Friday", category: "personal" }],
      }),
      "inbox.draft.reply.low": "Thanks Sam — confirming Tuesday.",
    });
    const writer = mkWriter();
    const approvals = mkApprovals();
    const orch = new Orchestrator({
      agents: [inboxAgent],
      tools: mkTools(),
      ledger: mkLedger(),
      policy: mkPolicy(),
      actions: mkRecorder(),
      approvals,
      models,
    });
    const res = await orch.run({
      householdId: HH,
      actor,
      graph: mkGraph(),
      writer,
      intent: inboxIntent,
    });
    expect(res.tasks[0]!.state).toBe("escalated");
    expect(models.calls).toEqual([
      "inbox.triage",
      "inbox.extract",
      "inbox.draft.reply.low",
    ]);
    expect(writer.written).toHaveLength(1);
    expect(writer.written[0]!.type).toBe("obligation.deadline");
    expect(approvals.queued).toHaveLength(1);
  });

  it("routes sensitive recipients through the T3 draft task class", async () => {
    const models = mkModels({
      "inbox.triage": JSON.stringify({
        urgency: "high",
        recipientClass: "counsel",
        requiresReply: "yes",
      }),
      "inbox.extract": JSON.stringify({ obligations: [] }),
      "inbox.draft.reply.sensitive": "Received; will reply after review.",
    });
    const orch = new Orchestrator({
      agents: [inboxAgent],
      tools: mkTools(),
      ledger: mkLedger(),
      policy: mkPolicy(),
      actions: mkRecorder(),
      approvals: mkApprovals(),
      models,
    });
    await orch.run({
      householdId: HH,
      actor,
      graph: mkGraph(),
      writer: mkWriter(),
      intent: {
        ...inboxIntent,
        attrs: {
          ...inboxIntent.attrs,
          fromName: "Attorney",
          fromAddress: "lawyer@example.com",
          subject: "Contract review",
          body: "Please reply confirming next steps.",
        },
      },
    });
    expect(models.calls).toContain("inbox.draft.reply.sensitive");
    expect(models.calls).not.toContain("inbox.draft.reply.low");
  });

  it("completes without a draft when triage says no reply needed", async () => {
    const models = mkModels({
      "inbox.triage": JSON.stringify({
        urgency: "low",
        recipientClass: "other",
        requiresReply: "no",
      }),
      "inbox.extract": JSON.stringify({ obligations: [] }),
    });
    const approvals = mkApprovals();
    const orch = new Orchestrator({
      agents: [inboxAgent],
      tools: mkTools(),
      ledger: mkLedger(),
      policy: mkPolicy(),
      actions: mkRecorder(),
      approvals,
      models,
    });
    const res = await orch.run({
      householdId: HH,
      actor,
      graph: mkGraph(),
      writer: mkWriter(),
      intent: inboxIntent,
    });
    expect(res.tasks[0]!.state).toBe("completed");
    expect(approvals.queued).toHaveLength(0);
    expect(models.calls).not.toContain("inbox.draft.reply.low");
  });
});
