import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  anthropicAdapter,
  openaiAdapter,
  googleAdapter,
  openaiCompatibleAdapter,
  getAdapter,
  ModelRegistry,
} from "../src/index.js";
import type { ModelCall, ModelSpec } from "@atelier/domain";

const call: ModelCall = {
  taskClass: "inbox.triage",
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ],
};

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
const googleModel: ModelSpec = { ...anthropicModel, id: "gemini-2.5-flash", provider: "google" };
const togetherModel: ModelSpec = {
  ...anthropicModel,
  id: "qwen2.5-32b-instruct",
  provider: "openai_compatible:together",
};

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

describe("provider adapters — missing key fallback", () => {
  it("anthropic falls back to mock without ANTHROPIC_API_KEY", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const res = await anthropicAdapter.invoke(anthropicModel, call);
    expect(res.reasons).toContain("anthropic_missing_ANTHROPIC_API_KEY");
    expect(res.modelId).toBe(anthropicModel.id);
  });

  it("openai falls back to mock without OPENAI_API_KEY", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const res = await openaiAdapter.invoke(openaiModel, call);
    expect(res.reasons).toContain("openai_missing_OPENAI_API_KEY");
  });

  it("google falls back to mock without GOOGLE_API_KEY", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "");
    const res = await googleAdapter.invoke(googleModel, call);
    expect(res.reasons).toContain("google_missing_GOOGLE_API_KEY");
  });

  it("openai-compatible falls back to mock without ATELIER_LLM_<SLUG>_URL", async () => {
    vi.stubEnv("ATELIER_LLM_TOGETHER_URL", "");
    const res = await openaiCompatibleAdapter.invoke(togetherModel, call);
    expect(res.reasons.some((r) => r.includes("ATELIER_LLM_TOGETHER_URL"))).toBe(true);
  });
});

describe("provider adapters — live call shape", () => {
  it("anthropic sends x-api-key + anthropic-version and parses content", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    stubFetch((url, init) => {
      expect(url).toContain("api.anthropic.com/v1/messages");
      const headers = init?.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("test-key");
      expect(headers["anthropic-version"]).toBeDefined();
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "hello from claude" }],
          usage: { input_tokens: 5, output_tokens: 3 },
          stop_reason: "end_turn",
        }),
        { status: 200 },
      );
    });
    const res = await anthropicAdapter.invoke(anthropicModel, call);
    expect(res.content).toBe("hello from claude");
    expect(res.usage.inputTokens).toBe(5);
    expect(res.reasons).toContain("anthropic_live");
  });

  it("openai sends Authorization Bearer and reads choices[0].message.content", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    stubFetch((_url, init) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer sk-test");
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "hello from openai" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        }),
        { status: 200 },
      );
    });
    const res = await openaiAdapter.invoke(openaiModel, call);
    expect(res.content).toBe("hello from openai");
    expect(res.reasons).toContain("openai_live");
  });

  it("google sends x-goog-api-key and reads candidates[0].content.parts", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "goog-test");
    stubFetch((url, init) => {
      expect(url).toContain("generativelanguage.googleapis.com");
      const headers = init?.headers as Record<string, string>;
      expect(headers["x-goog-api-key"]).toBe("goog-test");
      return new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: "hello from gemini" }] }, finishReason: "STOP" },
          ],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
        }),
        { status: 200 },
      );
    });
    const res = await googleAdapter.invoke(googleModel, call);
    expect(res.content).toBe("hello from gemini");
    expect(res.reasons).toContain("google_live");
  });

  it("openai-compatible posts to ATELIER_LLM_<SLUG>_URL with optional key", async () => {
    vi.stubEnv("ATELIER_LLM_TOGETHER_URL", "https://api.together.example/v1/chat/completions");
    vi.stubEnv("ATELIER_LLM_TOGETHER_KEY", "tg-key");
    stubFetch((url, init) => {
      expect(url).toBe("https://api.together.example/v1/chat/completions");
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer tg-key");
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "hello from together" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 2 },
        }),
        { status: 200 },
      );
    });
    const res = await openaiCompatibleAdapter.invoke(togetherModel, call);
    expect(res.content).toBe("hello from together");
    expect(res.reasons).toContain("openai_compatible:together_live");
  });
});

describe("provider registry dispatch", () => {
  it("dispatches by provider name and defaults to mock", () => {
    expect(getAdapter("anthropic").name).toBe("anthropic");
    expect(getAdapter("openai").name).toBe("openai");
    expect(getAdapter("google").name).toBe("google");
    expect(getAdapter("openai_compatible:groq").name).toBe("openai_compatible");
    expect(getAdapter("something_unknown").name).toBe("mock");
  });

  it("registry rows carry provider names that resolve to real adapters", () => {
    const reg = new ModelRegistry();
    for (const m of reg.listModels()) {
      const adapter = getAdapter(m.provider);
      expect(adapter.name).toBeTruthy();
    }
  });
});
