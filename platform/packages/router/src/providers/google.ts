import type { ModelCall, ModelResponse, ModelSpec } from "@atelier/domain";
import { invokeMock } from "./mock.js";
import { ProviderError, estimateCost, type ProviderAdapter } from "./types.js";

// Google Gemini adapter — direct HTTP to the generateContent endpoint.
// Falls back to mock when GOOGLE_API_KEY is not set.

const baseFor = (modelId: string): string =>
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent`;

export const googleAdapter: ProviderAdapter = {
  name: "google",
  async invoke(
    model: ModelSpec,
    call: ModelCall,
  ): Promise<Omit<ModelResponse, "modelCallId">> {
    const apiKey = process.env["GOOGLE_API_KEY"];
    if (!apiKey) {
      const mock = await invokeMock(model, call);
      return { ...mock, reasons: [...mock.reasons, "google_missing_GOOGLE_API_KEY"] };
    }

    const systemInstruction = call.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const contents = call.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    const body: Record<string, unknown> = {
      contents,
      ...(systemInstruction && {
        systemInstruction: { parts: [{ text: systemInstruction }] },
      }),
      generationConfig: {
        ...(call.maxOutputTokens !== undefined && { maxOutputTokens: call.maxOutputTokens }),
        ...(call.jsonMode && { responseMimeType: "application/json" }),
      },
    };

    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(baseFor(model.id), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new ProviderError(`google fetch failed: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new ProviderError(`google ${res.status}: ${text.slice(0, 300)}`, res.status);
    }
    const json = (await res.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        finishReason?: string;
      }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const latencyMs = Date.now() - t0;
    const content = (json.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("");
    const inputTokens = json.usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = json.usageMetadata?.candidatesTokenCount ?? 0;
    return {
      modelId: model.id,
      tier: model.tier,
      content,
      toolCalls: [],
      usage: {
        inputTokens,
        outputTokens,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        costUsdEstimated: estimateCost(model, inputTokens, outputTokens),
      },
      latencyMs,
      finishReason: mapStop(json.candidates?.[0]?.finishReason),
      reasons: ["google_live"],
    };
  },
};

const mapStop = (r: string | undefined): ModelResponse["finishReason"] => {
  switch (r) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
      return "content_filter";
    default:
      return "stop";
  }
};
