import { z } from "zod";

// Model tiering — see ../life-management/models.md.
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

// A single model invocation the router will fulfil.
export const ModelCall = z.object({
  taskClass: z.string(),
  minTier: TierId.optional(),
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant", "tool"]),
      content: z.string(),
    }),
  ),
  maxOutputTokens: z.number().int().positive().optional(),
  jsonMode: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type ModelCall = z.infer<typeof ModelCall>;

export interface ModelResponse {
  readonly modelCallId: string;
  readonly modelId: string;
  readonly tier: TierId;
  readonly content: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costUsdEstimated: number;
  };
  readonly latencyMs: number;
  readonly finishReason: "stop" | "length" | "content_filter" | "tool_calls" | "error";
  readonly reasons: readonly string[];
}
