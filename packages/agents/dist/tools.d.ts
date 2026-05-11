/**
 * Tool definitions for LLM function calling.
 *
 * These follow the Anthropic tool_use schema (identical structure to OpenAI
 * function calling). They expose the contract stack as callable tools so any
 * code-capable LLM can operate on contracts without custom prompting.
 *
 * Each tool corresponds to a method on ContractAgent<T>.
 */
export interface ToolInputSchema {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
}
export interface Tool {
    name: string;
    description: string;
    input_schema: ToolInputSchema;
}
export declare const CONTRACT_TOOLS: {
    readonly PARSE_CONTRACT: "parse_contract";
    readonly DRAFT_CONTRACT: "draft_contract";
    readonly EXTRACT_OBLIGATIONS: "extract_obligations";
    readonly CHECK_COMPLIANCE: "check_compliance";
    readonly ANALYZE_CLAUSE: "analyze_clause";
    readonly TRIGGER_EVENT: "trigger_event";
    readonly COMPARE_CONTRACTS: "compare_contracts";
};
export type ContractToolName = (typeof CONTRACT_TOOLS)[keyof typeof CONTRACT_TOOLS];
export declare const contractTools: Tool[];
//# sourceMappingURL=tools.d.ts.map