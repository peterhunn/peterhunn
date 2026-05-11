import type {
  ContractData,
  ContractEvent,
  ContractResponse,
  ContractState,
  Obligation,
} from "@legal-agents/core";
import { initialState } from "@legal-agents/core";
import type { ContractLogic, ContractTemplate } from "@legal-agents/core";
import type { LLMClient, Message } from "./llm.js";
import { LEGAL_AGENT_SYSTEM_PROMPT } from "./llm.js";
import { contractTools } from "./tools.js";

export interface ContractAnalysis {
  summary: string;
  parties: Array<{ name: string; role: string }>;
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
export class ContractAgent<
  TData extends ContractData,
  TEvent extends ContractEvent = ContractEvent,
  TResult = unknown,
> {
  constructor(
    private readonly template: ContractTemplate<TData>,
    private readonly logic: ContractLogic<TData, TEvent, TResult>,
    private readonly llm: LLMClient,
  ) {}

  /** Generate contract text from structured data using the template. */
  draft(data: TData): string {
    return this.template.draft(data);
  }

  /** Extract structured data from contract text using LLM + template variables. */
  async parse(text: string): Promise<Partial<TData>> {
    const heuristic = this.template.parse(text);

    const messages: Message[] = [
      {
        role: "user",
        content: `Parse this contract and extract all variable values as JSON.

Template variables to extract: ${this.template.variables().join(", ")}

Contract text:
${text}

Return a JSON object with the extracted values. Use the exact variable paths listed above as keys.`,
      },
    ];

    const result = await this.llm.complete(
      LEGAL_AGENT_SYSTEM_PROMPT,
      messages,
    );

    try {
      const jsonMatch = result.content.match(/```(?:json)?\s*([\s\S]*?)```/);
      const jsonStr = jsonMatch?.[1] ?? result.content;
      const llmExtracted = JSON.parse(jsonStr) as Partial<TData>;
      return { ...heuristic, ...llmExtracted };
    } catch {
      return heuristic;
    }
  }

  /** Analyze a contract text and return structured insights. */
  async analyze(text: string): Promise<ContractAnalysis> {
    const messages: Message[] = [
      {
        role: "user",
        content: `Analyze this contract and return a JSON object with these fields:
- summary: one paragraph plain-language summary
- parties: array of { name, role }
- obligations: array of { obligationId, party, action, deadline, condition, status }
- risks: array of risk strings
- missingClauses: array of recommended-but-absent clause descriptions

Contract:
${text}`,
      },
    ];

    const result = await this.llm.complete(
      LEGAL_AGENT_SYSTEM_PROMPT,
      messages,
      contractTools,
    );

    const jsonMatch = result.content.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch?.[1] ?? result.content;
    return JSON.parse(jsonStr) as ContractAnalysis;
  }

  /** Check whether the contract satisfies the given requirements. */
  async checkCompliance(
    text: string,
    requirements: string[],
  ): Promise<ComplianceResult> {
    const messages: Message[] = [
      {
        role: "user",
        content: `Evaluate this contract against the requirements below.

Return a JSON object with:
- passed: boolean (true only if ALL requirements are satisfied)
- results: array of { requirement, satisfied, explanation }

Requirements:
${requirements.map((r, i) => `${i + 1}. ${r}`).join("\n")}

Contract:
${text}`,
      },
    ];

    const result = await this.llm.complete(
      LEGAL_AGENT_SYSTEM_PROMPT,
      messages,
    );

    const jsonMatch = result.content.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch?.[1] ?? result.content;
    return JSON.parse(jsonStr) as ComplianceResult;
  }

  /** Suggest negotiation changes for the given contract text. */
  async negotiate(
    text: string,
    perspective: "disclosing" | "receiving" | "neutral" = "neutral",
  ): Promise<NegotiationSuggestion[]> {
    const messages: Message[] = [
      {
        role: "user",
        content: `Review this contract from the perspective of the ${perspective} party.

Return a JSON array of negotiation suggestions, each with:
- clause: the specific clause text being flagged
- issue: what's problematic about it
- suggestion: proposed alternative language or addition
- priority: "high" | "medium" | "low"

Contract:
${text}`,
      },
    ];

    const result = await this.llm.complete(
      LEGAL_AGENT_SYSTEM_PROMPT,
      messages,
    );

    const jsonMatch = result.content.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch?.[1] ?? result.content;
    return JSON.parse(jsonStr) as NegotiationSuggestion[];
  }

  /** Initialize contract state. Call this when a contract is activated (signed). */
  activate(data: TData): ContractState {
    if (this.logic.init) {
      return this.logic.init(data);
    }
    return initialState();
  }

  /** Submit a contract event and get updated state + result. */
  execute(
    event: TEvent,
    state: ContractState,
    data: TData,
  ): ContractResponse<TResult> {
    return this.logic.execute(event, { data, state, now: new Date() });
  }
}
