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
    complete(systemPrompt: string, messages: Message[], tools?: Tool[]): Promise<CompletionResult>;
}
/**
 * Anthropic adapter — wraps @anthropic-ai/sdk to satisfy LLMClient.
 *
 * Usage:
 *   import Anthropic from "@anthropic-ai/sdk";
 *   const client = new AnthropicClient(new Anthropic(), "claude-opus-4-7");
 */
export declare class AnthropicClient implements LLMClient {
    private readonly sdk;
    private readonly model;
    private readonly maxTokens;
    constructor(sdk: {
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
    }, model?: string, maxTokens?: number);
    complete(systemPrompt: string, messages: Message[], tools?: Tool[]): Promise<CompletionResult>;
}
/** The system prompt used for all legal contract agent interactions. */
export declare const LEGAL_AGENT_SYSTEM_PROMPT = "You are a legal contract agent with deep expertise in contract law and the Accord Project contract stack.\n\nYou work with contracts that have three layers:\n1. Text \u2014 human-readable Markdown contract text\n2. Data \u2014 structured JSON matching a typed contract model (Concerto-compatible)\n3. Logic \u2014 TypeScript functions that execute contract obligations and state transitions\n\nWhen analyzing contracts, always:\n- Identify the parties and their roles precisely\n- List obligations with their triggering conditions and deadlines\n- Flag clauses that are ambiguous, one-sided, or potentially unenforceable\n- Use the contract's data model to extract structured information\n\nWhen drafting contracts, always:\n- Use the provided template to ensure consistency\n- Validate that all required fields are present before drafting\n- Preserve the contract's machine-readable structure\n\nYou have access to tools for parsing, drafting, analyzing, and executing contracts.\nUse them systematically rather than relying solely on your training knowledge.";
//# sourceMappingURL=llm.d.ts.map