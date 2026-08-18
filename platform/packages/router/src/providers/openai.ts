import type { ModelCall, ModelResponse, ModelSpec } from "@atelier/domain";
import { invokeMock } from "./mock.js";
import { ProviderError, estimateCost, type ProviderAdapter } from "./types.js";

// OpenAI Chat Completions adapter — direct HTTP, no SDK.
// Falls back to mock when OPENAI_API_KEY is not set.

const DEFAULT_URL = "https://api.openai.com/v1/chat/completions";

export const openaiAdapter: ProviderAdapter = {
  name: "openai",
  async invoke(
    model: ModelSpec,
    call: ModelCall,
  ): Promise<Omit<ModelResponse, "modelCallId">> {
    const apiKey = process.env["OPENAI_API_KEY"];
    if (!apiKey) {
      const mock = await invokeMock(model, call);
      return { ...mock, reasons: [...mock.reasons, "openai_missing_OPENAI_API_KEY"] };
    }
    const baseUrl = process.env["OPENAI_BASE_URL"] ?? DEFAULT_URL;

    const body: Record<string, unknown> = {
      model: model.id,
      messages: call.messages.map((m) => ({
        role: m.role === "tool" ? "tool" : m.role,
        content: m.content,
      })),
      ...(call.maxOutputTokens !== undefined && { max_tokens: call.maxOutputTokens }),
      ...(call.jsonMode && { response_format: { type: "json_object" } }),
    };

    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new ProviderError(`openai fetch failed: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new ProviderError(`openai ${res.status}: ${text.slice(0, 300)}`, res.status);
    }
    const json = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const latencyMs = Date.now() - t0;
    const content = json.choices?.[0]?.message?.content ?? "";
    const inputTokens = json.usage?.prompt_tokens ?? 0;
    const outputTokens = json.usage?.completion_tokens ?? 0;
    return {
      modelId: model.id,
      tier: model.tier,
      content,
      usage: {
        inputTokens,
        outputTokens,
        costUsdEstimated: estimateCost(model, inputTokens, outputTokens),
      },
      latencyMs,
      finishReason: mapStop(json.choices?.[0]?.finish_reason),
      reasons: ["openai_live"],
    };
  },
};

const mapStop = (r: string | undefined): ModelResponse["finishReason"] => {
  switch (r) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    case "tool_calls":
      return "tool_calls";
    default:
      return "stop";
  }
};
