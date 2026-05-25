import type { Tool } from "./tools.js";

/**
 * Provider-agnostic LLM client interface.
 *
 * ContractAgent uses this adapter so callers can swap between Anthropic,
 * OpenAI, or any other provider by supplying a different implementation.
 */

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface CompletionResult {
  content: string;
  toolCalls?: ToolCall[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LLMClient {
  complete(
    systemPrompt: string,
    messages: Message[],
    tools?: Tool[],
  ): Promise<CompletionResult>;
}

/**
 * Anthropic adapter — wraps @anthropic-ai/sdk to satisfy LLMClient.
 *
 * Usage:
 *   import Anthropic from "@anthropic-ai/sdk";
 *   const client = new AnthropicClient(new Anthropic(), "claude-opus-4-7");
 */
export class AnthropicClient implements LLMClient {
  constructor(
    private readonly sdk: {
      beta: {
        promptCaching: {
          messages: {
            create(params: unknown): Promise<{
              content: Array<{
                type: string;
                text?: string;
                id?: string;
                name?: string;
                input?: unknown;
              }>;
              stop_reason: string | null;
            }>;
          };
        };
      };
    },
    private readonly model: string = "claude-opus-4-7",
    private readonly maxTokens: number = 4096,
  ) {}

  async complete(
    systemPrompt: string,
    messages: Message[],
    tools?: Tool[],
  ): Promise<CompletionResult> {
    const params: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxTokens,
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      messages,
    };
    if (tools && tools.length > 0) {
      params["tools"] = tools;
    }

    const response = await this.sdk.beta.promptCaching.messages.create(params);

    const textBlock = response.content.find((b) => b.type === "text");
    const toolBlocks = response.content.filter((b) => b.type === "tool_use");

    const result: CompletionResult = {
      content: textBlock?.text ?? "",
      stopReason: response.stop_reason ?? "end_turn",
    };
    if (toolBlocks.length > 0) {
      result.toolCalls = toolBlocks.map((b) => ({
        id: b.id ?? "",
        name: b.name ?? "",
        input: (b.input as Record<string, unknown>) ?? {},
      }));
    }
    return result;
  }
}

/** The system prompt used for all legal contract agent interactions. */
export const LEGAL_AGENT_SYSTEM_PROMPT = `You are a legal contract agent with deep expertise in contract law and the Accord Project contract stack.

You work with contracts that have three layers:
1. Text — human-readable Markdown contract text
2. Data — structured JSON matching a typed contract model (Concerto-compatible)
3. Logic — TypeScript functions that execute contract obligations and state transitions

When analyzing contracts, always:
- Identify the parties and their roles precisely
- List obligations with their triggering conditions and deadlines
- Flag clauses that are ambiguous, one-sided, or potentially unenforceable
- Use the contract's data model to extract structured information

When drafting contracts, always:
- Use the provided template to ensure consistency
- Validate that all required fields are present before drafting
- Preserve the contract's machine-readable structure

You have access to tools for parsing, drafting, analyzing, and executing contracts.
Use them systematically rather than relying solely on your training knowledge.`;
