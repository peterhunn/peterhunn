import type { ModelCall, ModelResponse, ModelSpec, ModelToolCall } from "@atelier/domain";
import { invokeMock } from "./mock.js";
import { ProviderError, estimateCost, type ProviderAdapter } from "./types.js";

// Anthropic Messages API adapter with tool-use and prompt caching.
// Docs:
//   https://docs.claude.com/en/api/messages
//   https://docs.claude.com/en/docs/prompt-caching
//   https://docs.claude.com/en/docs/tool-use

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// Anthropic-shaped content block; wraps a text or tool_use / tool_result.
type Block =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; cache_control?: { type: "ephemeral" } };

const toAnthropicPayload = (
  call: ModelCall,
): {
  system: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> | undefined;
  messages: Array<{ role: "user" | "assistant"; content: Block[] }>;
  tools:
    | Array<{
        name: string;
        description: string;
        input_schema: Record<string, unknown>;
        cache_control?: { type: "ephemeral" };
      }>
    | undefined;
  tool_choice: { type: "auto" | "any" | "tool"; name?: string } | undefined;
} => {
  // System — Anthropic accepts an array of text blocks for system, each
  // with optional cache_control. Collapse all system-role messages
  // preserving cache markers.
  const systemMsgs = call.messages.filter((m) => m.role === "system");
  const system =
    systemMsgs.length === 0
      ? undefined
      : systemMsgs.map((m) => ({
          type: "text" as const,
          text: m.content,
          ...(m.cache && { cache_control: { type: "ephemeral" as const } }),
        }));

  // Non-system messages. `tool` role → user message carrying a
  // tool_result block whose tool_use_id was carried in toolCallId.
  const messages: Array<{ role: "user" | "assistant"; content: Block[] }> = [];
  for (const m of call.messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.toolCallId ?? "",
            content: m.content,
            ...(m.cache && { cache_control: { type: "ephemeral" as const } }),
          },
        ],
      });
      continue;
    }
    messages.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content: [
        {
          type: "text",
          text: m.content,
          ...(m.cache && { cache_control: { type: "ephemeral" as const } }),
        },
      ],
    });
  }

  const tools =
    call.tools && call.tools.length > 0
      ? call.tools.map((t, i, arr) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
          // Mark the tail of the tools block for caching too — the
          // full tools list is typically a stable prefix.
          ...(i === arr.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
        }))
      : undefined;

  const tool_choice =
    call.toolChoice === "auto"
      ? { type: "auto" as const }
      : call.toolChoice === "any"
        ? { type: "any" as const }
        : call.toolChoice && "name" in call.toolChoice
          ? { type: "tool" as const, name: call.toolChoice.name }
          : undefined;

  return { system, messages, tools, tool_choice };
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

    const { system, messages, tools, tool_choice } = toAnthropicPayload(call);
    const body: Record<string, unknown> = {
      model: model.id,
      max_tokens: call.maxOutputTokens ?? 512,
      messages,
      ...(system && { system }),
      ...(tools && { tools }),
      ...(tool_choice && { tool_choice }),
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
      content?: Array<
        | { type: "text"; text?: string }
        | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
      >;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
      stop_reason?: string;
    };
    const latencyMs = Date.now() - t0;

    const textBlocks: string[] = [];
    const toolCalls: ModelToolCall[] = [];
    for (const b of json.content ?? []) {
      if (b.type === "text") textBlocks.push(b.text ?? "");
      else if (b.type === "tool_use")
        toolCalls.push({ id: b.id, name: b.name, input: b.input });
    }

    const inputTokens = json.usage?.input_tokens ?? 0;
    const outputTokens = json.usage?.output_tokens ?? 0;
    const cacheWriteInputTokens = json.usage?.cache_creation_input_tokens ?? 0;
    const cachedInputTokens = json.usage?.cache_read_input_tokens ?? 0;

    const reasons = ["anthropic_live"];
    if (cachedInputTokens > 0) reasons.push(`cache_read:${cachedInputTokens}`);
    if (cacheWriteInputTokens > 0) reasons.push(`cache_write:${cacheWriteInputTokens}`);

    return {
      modelId: model.id,
      tier: model.tier,
      content: textBlocks.join(""),
      toolCalls,
      usage: {
        inputTokens,
        outputTokens,
        cachedInputTokens,
        cacheWriteInputTokens,
        costUsdEstimated: estimateCost(model, inputTokens, outputTokens),
      },
      latencyMs,
      finishReason: mapStop(json.stop_reason),
      reasons,
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
