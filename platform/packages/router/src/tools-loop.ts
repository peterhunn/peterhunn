import type { ModelCall, ModelResponse, ModelToolCall } from "@atelier/domain";
import { callModel, type CallModelDeps, type CallModelOptions } from "./call.js";

// Multi-turn tool-use loop. Callers pass tool definitions and a
// handler; the loop keeps calling the model, dispatching every
// `tool_calls` block back into the handler, and appending tool_result
// messages until the model returns final text or a hard iteration cap
// hits. Every turn is recorded through the same ledger as a single
// callModel invocation.

export interface ToolHandlerContext {
  readonly toolCallId: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export interface ToolLoopOptions extends CallModelOptions {
  readonly handleToolUse: (
    call: ToolHandlerContext,
  ) => Promise<Record<string, unknown> | string>;
  readonly maxTurns?: number;
}

export interface ToolLoopResult {
  readonly final: ModelResponse;
  readonly turns: readonly ModelResponse[];
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCachedInputTokens: number;
  readonly totalCostUsdEstimated: number;
}

export const callModelWithTools = async (
  deps: CallModelDeps,
  initialCall: ModelCall,
  opts: ToolLoopOptions,
): Promise<ToolLoopResult> => {
  const maxTurns = opts.maxTurns ?? 8;
  const turns: ModelResponse[] = [];
  const messages = [...initialCall.messages];

  for (let i = 0; i < maxTurns; i++) {
    const call: ModelCall = { ...initialCall, messages };
    const res = await callModel(deps, call, opts);
    turns.push(res);

    if (res.toolCalls.length === 0 || res.finishReason !== "tool_calls") {
      return summarize(res, turns);
    }

    // Add the assistant's tool-call turn back so providers that echo
    // the assistant history stay consistent.
    messages.push({
      role: "assistant",
      content: renderToolCallAssistantMessage(res.toolCalls, res.content),
    });

    // Dispatch each tool_call, one at a time. If a handler throws, we
    // add a tool_result carrying the error and let the model recover.
    for (const tc of res.toolCalls) {
      let resultText: string;
      try {
        const out = await opts.handleToolUse({
          toolCallId: tc.id,
          name: tc.name,
          input: tc.input,
        });
        resultText = typeof out === "string" ? out : JSON.stringify(out);
      } catch (err) {
        resultText = JSON.stringify({ error: (err as Error).message });
      }
      messages.push({
        role: "tool",
        content: resultText,
        toolCallId: tc.id,
      });
    }
  }

  const last = turns[turns.length - 1]!;
  return summarize(last, turns);
};

const renderToolCallAssistantMessage = (
  toolCalls: readonly ModelToolCall[],
  content: string,
): string => {
  const summary = toolCalls
    .map((tc) => `${tc.name}(${JSON.stringify(tc.input)})`)
    .join("; ");
  return content ? `${content}\n[tool_calls] ${summary}` : `[tool_calls] ${summary}`;
};

const summarize = (final: ModelResponse, turns: readonly ModelResponse[]): ToolLoopResult => {
  let inp = 0;
  let out = 0;
  let cached = 0;
  let cost = 0;
  for (const t of turns) {
    inp += t.usage.inputTokens;
    out += t.usage.outputTokens;
    cached += t.usage.cachedInputTokens;
    cost += t.usage.costUsdEstimated;
  }
  return {
    final,
    turns,
    totalInputTokens: inp,
    totalOutputTokens: out,
    totalCachedInputTokens: cached,
    totalCostUsdEstimated: cost,
  };
};
