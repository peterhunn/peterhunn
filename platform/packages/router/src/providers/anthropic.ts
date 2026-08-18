import type { ModelCall, ModelResponse, ModelSpec } from "@atelier/domain";
import { invokeMock } from "./mock.js";
import { ProviderError, estimateCost, type ProviderAdapter } from "./types.js";

// Anthropic Messages API adapter — direct HTTP, no SDK.
// See https://docs.claude.com/en/api/messages.
// Falls back to the mock provider (with a visible reason) when
// ANTHROPIC_API_KEY is not set, so a fresh clone still runs.

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

const toAnthropicMessages = (
  call: ModelCall,
): { system: string | undefined; messages: Array<{ role: "user" | "assistant"; content: string }> } => {
  const systemParts = call.messages.filter((m) => m.role === "system").map((m) => m.content);
  const rest = call.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
      content: m.content,
    }));
  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: rest,
  };
};

export const anthropicAdapter: ProviderAdapter = {
  name: "anthropic",
  async invoke(
    model: ModelSpec,
    call: ModelCall,
  ): Promise<Omit<ModelResponse, "modelCallId">> {
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) {
      const mock = await invokeMock(model, call);
      return { ...mock, reasons: [...mock.reasons, "anthropic_missing_ANTHROPIC_API_KEY"] };
    }

    const { system, messages } = toAnthropicMessages(call);
    const body = {
      model: model.id,
      max_tokens: call.maxOutputTokens ?? 512,
      ...(system && { system }),
      messages,
    };

    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new ProviderError(`anthropic fetch failed: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new ProviderError(`anthropic ${res.status}: ${text.slice(0, 300)}`, res.status);
    }
    const json = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
      stop_reason?: string;
    };
    const latencyMs = Date.now() - t0;
    const content = (json.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    const inputTokens = json.usage?.input_tokens ?? 0;
    const outputTokens = json.usage?.output_tokens ?? 0;
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
      finishReason: mapStop(json.stop_reason),
      reasons: ["anthropic_live"],
    };
  },
};

const mapStop = (r: string | undefined): ModelResponse["finishReason"] => {
  switch (r) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return "stop";
  }
};
