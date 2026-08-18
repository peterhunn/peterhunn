import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  anthropicAdapter,
  openaiAdapter,
  callModelWithTools,
  ModelRegistry,
  Router,
  type ModelCallRecorder,
} from "../src/index.js";
import type { ModelCall, ModelResponse, ModelSpec } from "@atelier/domain";

const anthropicModel: ModelSpec = {
  id: "claude-sonnet-5",
  provider: "anthropic",
  displayName: "Claude Sonnet 5",
  tier: "T2",
  hosting: "provider_api",
  contextTokens: 200_000,
  capabilities: [],
  costPer1kInputUsd: 0.003,
  costPer1kOutputUsd: 0.015,
  latencyP50Ms: 700,
  latencyP95Ms: 2500,
  status: "available",
  limitations: [],
};

const openaiModel: ModelSpec = { ...anthropicModel, id: "gpt-5", provider: "openai" };

const stubFetch = (impl: (url: string, init?: RequestInit) => Response) => {
  vi.stubGlobal("fetch", vi.fn(async (u: string, i?: RequestInit) => impl(u, i)));
};

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Anthropic — tool use + caching", () => {
  it("sends system + tools with cache_control markers", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    stubFetch((_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        system?: Array<{ text: string; cache_control?: { type: string } }>;
        tools?: Array<{ name: string; cache_control?: { type: string } }>;
        tool_choice?: { type: string; name?: string };
      };
      expect(body.system?.[0]?.cache_control?.type).toBe("ephemeral");
      // Cache marker is stamped on the last tool block.
      const lastTool = body.tools?.[body.tools.length - 1];
      expect(lastTool?.cache_control?.type).toBe("ephemeral");
      expect(body.tool_choice).toEqual({ type: "tool", name: "list_vendors" });
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "hi" }],
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            cache_creation_input_tokens: 90,
            cache_read_input_tokens: 0,
          },
          stop_reason: "end_turn",
        }),
        { status: 200 },
      );
    });

    const call: ModelCall = {
      taskClass: "inbox.triage",
      messages: [{ role: "system", content: "You are…", cache: true }, { role: "user", content: "go" }],
      tools: [
        { name: "search_web", description: "search", inputSchema: {} },
        { name: "list_vendors", description: "list", inputSchema: {} },
      ],
      toolChoice: { name: "list_vendors" },
    };
    const res = await anthropicAdapter.invoke(anthropicModel, call);
    expect(res.usage.cacheWriteInputTokens).toBe(90);
    expect(res.reasons.some((r) => r.startsWith("cache_write"))).toBe(true);
  });

  it("parses tool_use content blocks into toolCalls", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    stubFetch(() =>
      new Response(
        JSON.stringify({
          content: [
            { type: "text", text: "I'll search." },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "search_web",
              input: { query: "fence repair" },
            },
          ],
          usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 20 },
          stop_reason: "tool_use",
        }),
        { status: 200 },
      ),
    );
    const res = await anthropicAdapter.invoke(anthropicModel, {
      taskClass: "research.open",
      messages: [{ role: "user", content: "find a fence contractor" }],
      tools: [{ name: "search_web", description: "search", inputSchema: {} }],
    });
    expect(res.finishReason).toBe("tool_calls");
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0]!.name).toBe("search_web");
    expect(res.toolCalls[0]!.input["query"]).toBe("fence repair");
    expect(res.usage.cachedInputTokens).toBe(20);
    expect(res.reasons.some((r) => r.startsWith("cache_read"))).toBe(true);
  });
});

describe("OpenAI — tool use + cached usage", () => {
  it("translates ModelCall tools to OpenAI functions and parses tool_calls", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    stubFetch((_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        tools?: Array<{ type: string; function: { name: string } }>;
        tool_choice?: unknown;
      };
      expect(body.tools?.[0]?.type).toBe("function");
      expect(body.tool_choice).toEqual({
        type: "function",
        function: { name: "search_web" },
      });
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "search_web", arguments: JSON.stringify({ q: "fence" }) },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: {
            prompt_tokens: 40,
            completion_tokens: 10,
            prompt_tokens_details: { cached_tokens: 25 },
          },
        }),
        { status: 200 },
      );
    });
    const res = await openaiAdapter.invoke(openaiModel, {
      taskClass: "research.open",
      messages: [{ role: "user", content: "search please" }],
      tools: [{ name: "search_web", description: "search", inputSchema: {} }],
      toolChoice: { name: "search_web" },
    });
    expect(res.finishReason).toBe("tool_calls");
    expect(res.toolCalls[0]!.name).toBe("search_web");
    expect(res.toolCalls[0]!.input["q"]).toBe("fence");
    expect(res.usage.cachedInputTokens).toBe(25);
  });
});

describe("callModelWithTools — multi-turn loop", () => {
  it("dispatches each tool_call to the handler and returns final text", async () => {
    const registry = new ModelRegistry();
    const router = new Router(registry);
    const recorded: unknown[] = [];
    const recorder: ModelCallRecorder = {
      record: (i) => {
        recorded.push(i);
        return { id: `mcl_${recorded.length}` };
      },
    };

    // Sequence: first turn → tool_call; second turn → final text.
    const responses: Array<Omit<ModelResponse, "modelCallId">> = [
      {
        modelId: "test",
        tier: "T2",
        content: "",
        toolCalls: [{ id: "toolu_1", name: "lookup", input: { key: "x" } }],
        usage: {
          inputTokens: 10,
          outputTokens: 3,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          costUsdEstimated: 0.001,
        },
        latencyMs: 5,
        finishReason: "tool_calls",
        reasons: [],
      },
      {
        modelId: "test",
        tier: "T2",
        content: "Final answer.",
        toolCalls: [],
        usage: {
          inputTokens: 15,
          outputTokens: 4,
          cachedInputTokens: 5,
          cacheWriteInputTokens: 0,
          costUsdEstimated: 0.001,
        },
        latencyMs: 5,
        finishReason: "stop",
        reasons: [],
      },
    ];
    let n = 0;
    // Intercept the mock adapter by monkey-patching fetch — but the
    // registry's default T2 models are Anthropic and openai_compatible
    // which need env keys. Force our own adapter via a router shim
    // by pointing the taskClass at a self-hosted T1 model that
    // resolves to Ollama (openai_compatible). We stub fetch to
    // return the sequence.
    vi.stubEnv("ATELIER_LLM_OLLAMA_URL", "http://localhost:11434/v1/chat/completions");
    stubFetch(() => {
      const r = responses[Math.min(n, responses.length - 1)]!;
      n++;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: r.content,
                tool_calls:
                  r.toolCalls.length > 0
                    ? r.toolCalls.map((tc) => ({
                        id: tc.id,
                        type: "function",
                        function: { name: tc.name, arguments: JSON.stringify(tc.input) },
                      }))
                    : undefined,
              },
              finish_reason: r.finishReason,
            },
          ],
          usage: { prompt_tokens: r.usage.inputTokens, completion_tokens: r.usage.outputTokens },
        }),
        { status: 200 },
      );
    });

    const handled: Array<{ name: string; input: unknown }> = [];
    const result = await callModelWithTools(
      { router, recorder },
      {
        taskClass: "inbox.triage",
        messages: [{ role: "user", content: "look it up" }],
        tools: [{ name: "lookup", description: "lookup", inputSchema: {} }],
      },
      {
        handleToolUse: async ({ name, input }) => {
          handled.push({ name, input });
          return { answer: 42 };
        },
      },
    );
    expect(handled).toEqual([{ name: "lookup", input: { key: "x" } }]);
    expect(result.turns).toHaveLength(2);
    expect(result.final.content).toBe("Final answer.");
    expect(result.totalInputTokens).toBeGreaterThan(0);
    expect(recorded).toHaveLength(2);
  });
});
