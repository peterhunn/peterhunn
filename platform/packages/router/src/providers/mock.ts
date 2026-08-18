import type { ModelCall, ModelResponse, ModelSpec } from "@atelier/domain";

// Mock provider used until real adapters are wired in. Deterministic
// output that carries the model id, so tests + traces can prove which
// tier ran the call.
export const invokeMock = async (
  model: ModelSpec,
  call: ModelCall,
): Promise<Omit<ModelResponse, "modelCallId">> => {
  const inputChars = call.messages.reduce((n, m) => n + m.content.length, 0);
  const inputTokens = Math.max(1, Math.ceil(inputChars / 4));
  const outputText = `mock:${model.id}:${call.taskClass}`;
  const outputTokens = Math.ceil(outputText.length / 4);
  const costUsdEstimated =
    (inputTokens / 1000) * model.costPer1kInputUsd +
    (outputTokens / 1000) * model.costPer1kOutputUsd;
  return {
    modelId: model.id,
    tier: model.tier,
    content: outputText,
    usage: { inputTokens, outputTokens, costUsdEstimated },
    latencyMs: model.latencyP50Ms,
    finishReason: "stop",
    reasons: ["mock_provider"],
  };
};
