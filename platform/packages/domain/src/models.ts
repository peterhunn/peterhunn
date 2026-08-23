import { z } from "zod";

// Model tiering — see docs/24-model-routing.md.
// T0 is not an LLM; it exists so the tier axis extends to deterministic
// code and the router can report "no LLM needed" as a first-class
// decision.
export const TierId = z.enum(["T0", "T1", "T2", "T3"]);
export type TierId = z.infer<typeof TierId>;

export const TIER_RANK: Record<TierId, number> = {
  T0: 0,
  T1: 1,
  T2: 2,
  T3: 3,
};

export const tierAtLeast = (a: TierId, b: TierId): TierId =>
  TIER_RANK[a] >= TIER_RANK[b] ? a : b;

// Hosting mode — where the model is executed. Self-hosted models are
// exposed via an internal endpoint; provider models are external.
export const HostingMode = z.enum(["self_hosted", "provider_api"]);
export type HostingMode = z.infer<typeof HostingMode>;

export const ModelCapability = z.enum([
  "function_calling",
  "json_mode",
  "vision",
  "streaming",
  "long_context",
]);
export type ModelCapability = z.infer<typeof ModelCapability>;

export interface ModelSpec {
  readonly id: string;
  readonly provider: string;
  readonly displayName: string;
  readonly tier: TierId;
  readonly hosting: HostingMode;
  readonly contextTokens: number;
  readonly capabilities: readonly ModelCapability[];
  readonly costPer1kInputUsd: number;
  readonly costPer1kOutputUsd: number;
  readonly latencyP50Ms: number;
  readonly latencyP95Ms: number;
  readonly status: "available" | "degraded" | "unavailable";
  readonly limitations: readonly string[];
}

// Task classes name the reason for an LLM call. The registry maps them
// to a minimum tier. New task classes should be added in code so the
// router can enforce the mapping without host-configurable magic.
export type TaskClassId = string;

export interface TaskClassSpec {
  readonly id: TaskClassId;
  readonly minTier: TierId;
  readonly description: string;
  readonly requiresCapabilities?: readonly ModelCapability[];
}

// Tool definition — provider-agnostic. Adapters translate to the
// provider's own tool/function-calling schema.
export const ToolDefinition = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.unknown()),
});
export type ToolDefinition = z.infer<typeof ToolDefinition>;

// A single model invocation the router will fulfil.
// `cache: true` on a message asks the provider to cache the prefix
// up to and including that message; adapters that support prompt
// caching (Anthropic today) honor the marker, others ignore it.
export const ModelCall = z.object({
  taskClass: z.string(),
  minTier: TierId.optional(),
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant", "tool"]),
      content: z.string(),
      cache: z.boolean().optional(),
      toolCallId: z.string().optional(),
    }),
  ),
  tools: z.array(ToolDefinition).optional(),
  toolChoice: z
    .union([z.literal("auto"), z.literal("any"), z.object({ name: z.string() })])
    .optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  jsonMode: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type ModelCall = z.infer<typeof ModelCall>;

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export interface ModelResponse {
  readonly modelCallId: string;
  readonly modelId: string;
  readonly tier: TierId;
  readonly content: string;
  readonly toolCalls: readonly ModelToolCall[];
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens: number;
    readonly cacheWriteInputTokens: number;
    readonly costUsdEstimated: number;
  };
  readonly latencyMs: number;
  readonly finishReason: "stop" | "length" | "content_filter" | "tool_calls" | "error";
  readonly reasons: readonly string[];
}
