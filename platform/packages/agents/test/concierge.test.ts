import { describe, it, expect } from "vitest";
import {
  Orchestrator,
  ToolRegistry,
  conciergeAgent,
  smsSendTool,
  type ActionRecorder,
  type AgentGraphWriter,
  type ApprovalSink,
  type GraphView,
  type Intent,
  type MessagingOutboundSink,
  type ModelRuntime,
  type PolicyRuntime,
  type TaskLedger,
} from "../src/index.js";
import type { HouseholdId, ModelResponse, PolicyDecision } from "@atelier/domain";

const HH = "hh_test" as HouseholdId;
const actor = { type: "customer" as const, id: "cus_ada", displayName: "Ada" };

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

const mkPolicy = (decision: PolicyDecision["decision"] = "auto_execute"): PolicyRuntime => ({
  evaluate: (): PolicyDecision => ({
    decision,
    requiredRung: decision === "auto_execute" ? "execute" : "ask",
    authorityId: "pol_test" as never,
    approver: decision === "auto_execute" ? undefined : { type: "manager" },
    reasons: [],
    policiesChecked: [],
    evaluatedAt: new Date().toISOString(),
  }),
});

const mkRecorder = (): ActionRecorder => ({ record: () => ({ id: "act_x" }) });
const mkApprovals = (): ApprovalSink & { queued: number } => {
  const state = { queued: 0 };
  return Object.assign(
    { enqueue: () => ({ id: "apr_x" }) } as ApprovalSink,
    {
      get queued() {
        state.queued++;
        return state.queued;
      },
    },
  );
};
const mkWriter = (): AgentGraphWriter => ({
  writeNode: () => ({ id: "nod_x" }),
  supersedeNode: () => {},
});
const mkGraph = (): GraphView => ({ listNodes: () => [] });

const mkModels = (canned: string): ModelRuntime => ({
  callModel: async (_hh, _run, _task, call): Promise<ModelResponse> => {
    expect(call.taskClass).toBe("concierge.reply.draft");
    return {
      modelCallId: "mcl_1",
      modelId: "test",
      tier: "T2",
      content: canned,
      toolCalls: [],
      usage: {
        inputTokens: 60,
        outputTokens: 30,
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
});

const mkOutbound = (): MessagingOutboundSink & { sent: unknown[] } => {
  const sent: unknown[] = [];
  const sink = {
    sent,
    async send(_hh: HouseholdId, input: { channel: string; to: string; body: string }) {
      sent.push(input);
      return {
        provider: "twilio" as const,
        externalMessageId: "SM_sent",
        from: "+15555550100",
        to: input.to,
        eventId: "mev_sent",
      };
    },
  };
  return sink;
};

const replyIntent: Intent = {
  kind: "concierge.reply",
  subjectPrincipalId: "any_principal",
  attrs: {
    channel: "sms",
    toAddress: "+14158675309",
    currentMessage: "thanks!",
    fromName: "Ada",
    priorTurns: [
      { role: "customer", content: "can you book a car for 7?" },
      { role: "agent", content: "Done — confirmed for 7pm." },
    ],
  },
  origin: { source: "customer", by: "sms:+14158675309" },
};

describe("concierge agent", () => {
  it("drafts a reply, invokes sms.send under policy, and reports completed on auto_execute", async () => {
    const models = mkModels(
      JSON.stringify({ reply: "You got it — talk soon." }),
    );
    const outbound = mkOutbound();
    const tools = new ToolRegistry();
    tools.register(smsSendTool);
    const orch = new Orchestrator({
      agents: [conciergeAgent],
      tools,
      ledger: mkLedger(),
      policy: mkPolicy("auto_execute"),
      actions: mkRecorder(),
      approvals: mkApprovals(),
      models,
      messagingOutbound: outbound,
    });

    const res = await orch.run({
      householdId: HH,
      actor,
      graph: mkGraph(),
      writer: mkWriter(),
      intent: replyIntent,
    });

    expect(res.tasks[0]!.state).toBe("completed");
    // The draft went through sms.send → the runtime seam.
    expect(outbound.sent).toHaveLength(1);
    expect((outbound.sent[0] as { body: string }).body).toBe("You got it — talk soon.");
    expect((outbound.sent[0] as { to: string }).to).toBe("+14158675309");
    const outputs = res.tasks[0]!.outputs as { sent?: { sentMessageId: string } };
    expect(outputs.sent?.sentMessageId).toBe("SM_sent");
  });

  it("lands as proposing_action when policy defers to approval (draft/ask)", async () => {
    const models = mkModels(JSON.stringify({ reply: "On it — I'll follow up." }));
    const outbound = mkOutbound();
    const tools = new ToolRegistry();
    tools.register(smsSendTool);
    const orch = new Orchestrator({
      agents: [conciergeAgent],
      tools,
      ledger: mkLedger(),
      policy: mkPolicy("manager_review"),
      actions: mkRecorder(),
      approvals: mkApprovals(),
      models,
      messagingOutbound: outbound,
    });

    const res = await orch.run({
      householdId: HH,
      actor,
      graph: mkGraph(),
      writer: mkWriter(),
      intent: replyIntent,
    });
    expect(res.tasks[0]!.state).toBe("proposing_action");
    // Nothing sent — policy blocked the tool from executing.
    expect(outbound.sent).toHaveLength(0);
    const outputs = res.tasks[0]!.outputs as { drafted: string; policyDecision: string };
    expect(outputs.drafted).toBe("On it — I'll follow up.");
    expect(outputs.policyDecision).toBe("manager_review");
  });

  it("escalates without invoking sms.send when the model asks to", async () => {
    const models = mkModels(
      JSON.stringify({
        reply: "Let me check on that and get back to you.",
        escalate: true,
        escalateReason: "Customer asked us to wire $5k — needs manager approval before we do anything.",
      }),
    );
    const outbound = mkOutbound();
    const tools = new ToolRegistry();
    tools.register(smsSendTool);
    const orch = new Orchestrator({
      agents: [conciergeAgent],
      tools,
      ledger: mkLedger(),
      policy: mkPolicy("auto_execute"),
      actions: mkRecorder(),
      approvals: mkApprovals(),
      models,
      messagingOutbound: outbound,
    });
    const res = await orch.run({
      householdId: HH,
      actor,
      graph: mkGraph(),
      writer: mkWriter(),
      intent: replyIntent,
    });
    expect(res.tasks[0]!.state).toBe("escalated");
    expect(outbound.sent).toHaveLength(0);
    const outputs = res.tasks[0]!.outputs as { escalateReason: string; drafted: string };
    expect(outputs.escalateReason).toMatch(/manager approval/);
    expect(outputs.drafted).toBe("Let me check on that and get back to you.");
  });
});
