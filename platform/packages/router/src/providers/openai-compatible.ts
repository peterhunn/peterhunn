import type { ModelCall, ModelResponse, ModelSpec, ModelToolCall } from "@atelier/domain";
import { invokeMock } from "./mock.js";
import { ProviderError, estimateCost, type ProviderAdapter } from "./types.js";

// Generic OpenAI-compatible adapter. Same wire shape as openai.ts for
// tools; endpoints that don't support tools ignore the field. Prompt
// caching is provider-specific; the `cache` marker is preserved
// through the message but not translated here.

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

    const messages = call.messages.map((m) => {
      if (m.role === "tool") {
        return { role: "tool", content: m.content, tool_call_id: m.toolCallId ?? "" };
      }
      return { role: m.role, content: m.content };
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
        message?: {
          content?: string | null;
          tool_calls?: Array<{
            id: string;
            type?: "function";
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
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
    return {
      modelId: model.id,
      tier: model.tier,
      content,
      toolCalls,
      usage: {
        inputTokens,
        outputTokens,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        costUsdEstimated: estimateCost(model, inputTokens, outputTokens),
      },
      latencyMs,
      finishReason:
        toolCalls.length > 0
          ? "tool_calls"
          : choice?.finish_reason === "length"
            ? "length"
            : "stop",
      reasons: [`${model.provider}_live`],
    };
  },
};
