import type { ContractData, ContractEvent, ContractResponse, ContractState, Obligation } from "@legal-agents/core";
import type { ContractLogic, ContractTemplate } from "@legal-agents/core";
import type { LLMClient } from "./llm.js";
export interface ContractAnalysis {
    summary: string;
    parties: Array<{
        name: string;
        role: string;
    }>;
    obligations: Obligation[];
    risks: string[];
    missingClauses: string[];
}
export interface ComplianceResult {
    passed: boolean;
    results: Array<{
        requirement: string;
        satisfied: boolean;
        explanation: string;
    }>;
}
export interface NegotiationSuggestion {
    clause: string;
    issue: string;
    suggestion: string;
    priority: "high" | "medium" | "low";
}
/**
 * ContractAgent<T> — orchestrates model, template, logic, and LLM.
 *
 * This is the primary entry point for building legal AI applications.
 * It exposes the Accord Project contract stack (data + template + logic)
 * through a simple async API that any application can call.
 *
 * Example:
 *   const agent = new ContractAgent(ndaTemplate, ndaLogic, llmClient);
 *   const text = await agent.draft({ disclosingParty: ..., receivingParty: ... });
 *   const analysis = await agent.analyze(text);
 *   const state = agent.activate(data);
 *   const response = agent.execute({ type: "BREACH_NOTIFIED", ... }, state, data);
 */
export declare class ContractAgent<TData extends ContractData, TEvent extends ContractEvent = ContractEvent, TResult = unknown> {
    private readonly template;
    private readonly logic;
    private readonly llm;
    constructor(template: ContractTemplate<TData>, logic: ContractLogic<TData, TEvent, TResult>, llm: LLMClient);
    /** Generate contract text from structured data using the template. */
    draft(data: TData): string;
    /** Extract structured data from contract text using LLM + template variables. */
    parse(text: string): Promise<Partial<TData>>;
    /** Analyze a contract text and return structured insights. */
    analyze(text: string): Promise<ContractAnalysis>;
    /** Check whether the contract satisfies the given requirements. */
    checkCompliance(text: string, requirements: string[]): Promise<ComplianceResult>;
    /** Suggest negotiation changes for the given contract text. */
    negotiate(text: string, perspective?: "disclosing" | "receiving" | "neutral"): Promise<NegotiationSuggestion[]>;
    /** Initialize contract state. Call this when a contract is activated (signed). */
    activate(data: TData): ContractState;
    /** Submit a contract event and get updated state + result. */
    execute(event: TEvent, state: ContractState, data: TData): ContractResponse<TResult>;
}
//# sourceMappingURL=agent.d.ts.map