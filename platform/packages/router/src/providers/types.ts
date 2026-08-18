import type { ModelCall, ModelResponse, ModelSpec } from "@atelier/domain";

// Every provider adapter conforms to the same narrow surface. The
// router does not care whether the concrete adapter is talking to
// Anthropic, OpenAI, Google, an OpenAI-compatible endpoint, or a
// mock — only that it returns the normalized ModelResponse shape.
export interface ProviderAdapter {
  readonly name: string;
  invoke(
    model: ModelSpec,
    call: ModelCall,
  ): Promise<Omit<ModelResponse, "modelCallId">>;
}

export class ProviderError extends Error {
  override readonly name = "ProviderError" as const;
  constructor(
    message: string,
    readonly status: number | undefined = undefined,
  ) {
    super(message);
  }
}

// Shared helper for token estimates when a provider doesn't return them.
export const estimateTokens = (chars: number): number =>
  Math.max(1, Math.ceil(chars / 4));

// Estimate cost from usage against a model's rates.
export const estimateCost = (
  model: ModelSpec,
  inputTokens: number,
  outputTokens: number,
): number =>
  (inputTokens / 1000) * model.costPer1kInputUsd +
  (outputTokens / 1000) * model.costPer1kOutputUsd;
