import type { ModelCall, ModelResponse, ModelSpec, ModelToolCall } from "@atelier/domain";
import { invokeMock } from "./mock.js";
import { ProviderError, estimateCost, type ProviderAdapter } from "./types.js";

// OpenAI Chat Completions adapter — direct HTTP, no SDK. Supports
// tool calling. OpenAI does prompt-prefix caching automatically on
// their side for eligible prompts; the `cache` marker on messages is
// a no-op here but is preserved so provider-swap is lossless.

const DEFAULT_URL = "https://api.openai.com/v1/chat/completions";

type OpenAIMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; content: string; tool_call_id: string };

const toOpenAIPayload = (call: ModelCall) => {
  const messages: OpenAIMessage[] = call.messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", content: m.content, tool_call_id: m.toolCallId ?? "" };
    }
    return { role: m.role, content: m.content } as OpenAIMessage;
  });
  const tools =
    call.tools && call.tools.length > 0
      ? call.tools.map((t) => ({
          type: "function" as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          },
        }))
      : undefined;
  const tool_choice =
    call.toolChoice === "auto"
      ? "auto"
      : call.toolChoice === "any"
        ? "required"
        : call.toolChoice && "name" in call.toolChoice
          ? { type: "function" as const, function: { name: call.toolChoice.name } }
          : undefined;
  return { messages, tools, tool_choice };
};

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

    const { messages, tools, tool_choice } = toOpenAIPayload(call);
    const body: Record<string, unknown> = {
      model: model.id,
      messages,
      ...(call.maxOutputTokens !== undefined && { max_tokens: call.maxOutputTokens }),
      ...(call.jsonMode && { response_format: { type: "json_object" } }),
      ...(tools && { tools }),
      ...(tool_choice !== undefined && { tool_choice }),
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
        message?: {
          content?: string | null;
          tool_calls?: Array<{
            id: string;
            type: "function";
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason?: string;
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };
    };
    const latencyMs = Date.now() - t0;
    const choice = json.choices?.[0];
    const content = choice?.message?.content ?? "";
    const toolCalls: ModelToolCall[] =
      choice?.message?.tool_calls?.map((tc) => {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          input = { _raw: tc.function.arguments };
        }
        return { id: tc.id, name: tc.function.name, input };
      }) ?? [];
    const inputTokens = json.usage?.prompt_tokens ?? 0;
    const outputTokens = json.usage?.completion_tokens ?? 0;
    const cachedInputTokens = json.usage?.prompt_tokens_details?.cached_tokens ?? 0;

    const reasons = ["openai_live"];
    if (cachedInputTokens > 0) reasons.push(`cache_read:${cachedInputTokens}`);

    return {
      modelId: model.id,
      tier: model.tier,
      content: content ?? "",
      toolCalls,
      usage: {
        inputTokens,
        outputTokens,
        cachedInputTokens,
        cacheWriteInputTokens: 0,
        costUsdEstimated: estimateCost(model, inputTokens, outputTokens),
      },
      latencyMs,
      finishReason: mapStop(choice?.finish_reason, toolCalls.length > 0),
      reasons,
    };
  },
};

const mapStop = (
  r: string | undefined,
  hasToolCalls: boolean,
): ModelResponse["finishReason"] => {
  if (hasToolCalls) return "tool_calls";
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
