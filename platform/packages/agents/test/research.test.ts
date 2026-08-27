import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  Orchestrator,
  ToolRegistry,
  researchAgent,
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
const mkGraph = (): GraphView => ({ listNodes: () => [] });

// Model runtime that scripts a tool-use loop: first turn calls
// search_web; second turn calls fetch_url; third turn returns a
// final summary.
const mkResearchModels = (): ModelRuntime & {
  turns: Array<{ withHandler: boolean; toolCallsIssued: string[] }>;
} => {
  const turns: Array<{ withHandler: boolean; toolCallsIssued: string[] }> = [];
  const runtime: ModelRuntime = {
    callModel: async () => {
      throw new Error("plain callModel not expected in research tests");
    },
    callModelWithTools: async (_hh, _run, _task, call, opts) => {
      const toolCallsIssued: string[] = [];
      let searched = false;
      let fetched = false;

      const dispatch = async (
        name: string,
        input: Record<string, unknown>,
      ): Promise<Record<string, unknown> | string> => {
        toolCallsIssued.push(name);
        return await opts.handleToolUse({
          toolCallId: `toolu_${toolCallsIssued.length}`,
          name,
          input,
        });
      };

      // Simulate three model turns.
      await dispatch("search_web", { query: "test question" });
      searched = true;
      await dispatch("fetch_url", {
        url: "https://example.com/test/overview",
      });
      fetched = true;

      turns.push({ withHandler: true, toolCallsIssued });

      const summary = [
        "Summary of research on the question.",
        "Top candidates:",
        "1. Option A — best overall.",
        "2. Option B — best value.",
        "3. Option C — premium.",
        "",
        "Sources consulted: https://example.com/test/overview",
        `(search=${searched}, fetch=${fetched}, tools=${call.tools?.length ?? 0})`,
      ].join("\n");

      return {
        finalContent: summary,
        finalToolCalls: [],
        turns: 3,
        totalInputTokens: 100,
        totalOutputTokens: 80,
        totalCachedInputTokens: 30,
        totalCostUsdEstimated: 0.02,
      };
    },
  };
  // Expose the captured turns array on the returned runtime.
  // Object.assign would work here (arrays are value-descriptor-
  // safe by reference), but keep the pattern consistent with the
  // other test helpers that use defineProperty for accessors.
  return Object.assign(runtime, { turns });
};

// Keep the research agent's real web tools hermetic in tests:
// no provider keys, and every fetch fails so both Jina and raw paths
// collapse to the deterministic mock fallback.
beforeEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.stubEnv("TAVILY_API_KEY", "");
  vi.stubEnv("SERPER_API_KEY", "");
  vi.stubEnv("BRAVE_SEARCH_API_KEY", "");
  vi.stubEnv("ATELIER_DISABLE_JINA", "1");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("network disabled", { status: 500 })),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const researchIntent: Intent = {
  kind: "research.query",
  subjectPrincipalId: "any_principal",
  attrs: { question: "Compare three ergonomic office chairs under $800." },
  origin: { source: "customer", by: "test" },
};

describe("research agent", () => {
  it("dispatches search_web and fetch_url via the tool loop and returns a summary", async () => {
    const models = mkResearchModels();
    const orch = new Orchestrator({
      agents: [researchAgent],
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
      writer: mkWriter(),
      intent: researchIntent,
    });
    expect(res.tasks[0]!.state).toBe("completed");
    const outputs = res.tasks[0]!.outputs as {
      summary: string;
      toolTrace: Array<{ name: string }>;
      turns: number;
      totalCostUsdEstimated: number;
    };
    expect(outputs.summary).toContain("Top candidates");
    expect(outputs.toolTrace.map((t) => t.name)).toEqual(["search_web", "fetch_url"]);
    expect(outputs.turns).toBe(3);
    expect(outputs.totalCostUsdEstimated).toBe(0.02);
    expect(models.turns).toHaveLength(1);
    expect(models.turns[0]!.toolCallsIssued).toEqual(["search_web", "fetch_url"]);
  });

  it("fails cleanly if the model returns no summary text", async () => {
    const orch = new Orchestrator({
      agents: [researchAgent],
      tools: new ToolRegistry(),
      ledger: mkLedger(),
      policy: mkPolicy(),
      actions: mkRecorder(),
      approvals: mkApprovals(),
      models: {
        callModel: async () => {
          throw new Error("unexpected");
        },
        callModelWithTools: async () => ({
          finalContent: "",
          finalToolCalls: [],
          turns: 1,
          totalInputTokens: 5,
          totalOutputTokens: 0,
          totalCachedInputTokens: 0,
          totalCostUsdEstimated: 0.0001,
        }),
      },
    });
    const res = await orch.run({
      householdId: HH,
      actor,
      graph: mkGraph(),
      writer: mkWriter(),
      intent: researchIntent,
    });
    expect(res.tasks[0]!.state).toBe("failed");
  });
});
