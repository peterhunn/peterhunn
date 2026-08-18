import type { ModelCall, ModelResponse, ModelSpec } from "@atelier/domain";
import { invokeMock } from "./mock.js";
import { ProviderError, estimateCost, type ProviderAdapter } from "./types.js";

// Generic OpenAI-compatible adapter — one adapter, many providers.
// Covers Ollama, vLLM, Together, Groq, Fireworks, DeepInfra, Anyscale,
// LM Studio, and any other endpoint that speaks the /v1/chat/completions
// contract. Model rows carry a provider name in a supported set; env
// vars name the base URL and (optional) API key per provider.
//
// Convention (see registry.ts):
//   provider: "openai_compatible:<slug>"
//   env:      ATELIER_LLM_<SLUG>_URL, ATELIER_LLM_<SLUG>_KEY
//   e.g.      ATELIER_LLM_TOGETHER_URL, ATELIER_LLM_TOGETHER_KEY

const slugFromProvider = (name: string): string | null => {
  const m = /^openai_compatible:([a-z0-9_]+)$/.exec(name);
  return m ? m[1]!.toUpperCase() : null;
};

export const openaiCompatibleAdapter: ProviderAdapter = {
  name: "openai_compatible",
  async invoke(
    model: ModelSpec,
    call: ModelCall,
  ): Promise<Omit<ModelResponse, "modelCallId">> {
    const slug = slugFromProvider(model.provider);
    if (!slug) {
      throw new ProviderError(`invalid openai_compatible provider: ${model.provider}`);
    }
    const urlEnv = `ATELIER_LLM_${slug}_URL`;
    const keyEnv = `ATELIER_LLM_${slug}_KEY`;
    const baseUrl = process.env[urlEnv];
    if (!baseUrl) {
      const mock = await invokeMock(model, call);
      return {
        ...mock,
        reasons: [...mock.reasons, `openai_compatible_missing_${urlEnv}`],
      };
    }
    const apiKey = process.env[keyEnv];

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
          ...(apiKey && { authorization: `Bearer ${apiKey}` }),
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new ProviderError(`${model.provider} fetch failed: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new ProviderError(
        `${model.provider} ${res.status}: ${text.slice(0, 300)}`,
        res.status,
      );
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
      finishReason:
        json.choices?.[0]?.finish_reason === "length" ? "length" : "stop",
      reasons: [`${model.provider}_live`],
    };
  },
};
