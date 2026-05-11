import { initialState } from "@legal-agents/core";
import { LEGAL_AGENT_SYSTEM_PROMPT } from "./llm.js";
import { contractTools } from "./tools.js";
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
export class ContractAgent {
    template;
    logic;
    llm;
    constructor(template, logic, llm) {
        this.template = template;
        this.logic = logic;
        this.llm = llm;
    }
    /** Generate contract text from structured data using the template. */
    draft(data) {
        return this.template.draft(data);
    }
    /** Extract structured data from contract text using LLM + template variables. */
    async parse(text) {
        const heuristic = this.template.parse(text);
        const messages = [
            {
                role: "user",
                content: `Parse this contract and extract all variable values as JSON.

Template variables to extract: ${this.template.variables().join(", ")}

Contract text:
${text}

Return a JSON object with the extracted values. Use the exact variable paths listed above as keys.`,
            },
        ];
        const result = await this.llm.complete(LEGAL_AGENT_SYSTEM_PROMPT, messages);
        try {
            const jsonMatch = result.content.match(/```(?:json)?\s*([\s\S]*?)```/);
            const jsonStr = jsonMatch?.[1] ?? result.content;
            const llmExtracted = JSON.parse(jsonStr);
            return { ...heuristic, ...llmExtracted };
        }
        catch {
            return heuristic;
        }
    }
    /** Analyze a contract text and return structured insights. */
    async analyze(text) {
        const messages = [
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
        const result = await this.llm.complete(LEGAL_AGENT_SYSTEM_PROMPT, messages, contractTools);
        const jsonMatch = result.content.match(/```(?:json)?\s*([\s\S]*?)```/);
        const jsonStr = jsonMatch?.[1] ?? result.content;
        return JSON.parse(jsonStr);
    }
    /** Check whether the contract satisfies the given requirements. */
    async checkCompliance(text, requirements) {
        const messages = [
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
        const result = await this.llm.complete(LEGAL_AGENT_SYSTEM_PROMPT, messages);
        const jsonMatch = result.content.match(/```(?:json)?\s*([\s\S]*?)```/);
        const jsonStr = jsonMatch?.[1] ?? result.content;
        return JSON.parse(jsonStr);
    }
    /** Suggest negotiation changes for the given contract text. */
    async negotiate(text, perspective = "neutral") {
        const messages = [
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
        const result = await this.llm.complete(LEGAL_AGENT_SYSTEM_PROMPT, messages);
        const jsonMatch = result.content.match(/```(?:json)?\s*([\s\S]*?)```/);
        const jsonStr = jsonMatch?.[1] ?? result.content;
        return JSON.parse(jsonStr);
    }
    /** Initialize contract state. Call this when a contract is activated (signed). */
    activate(data) {
        if (this.logic.init) {
            return this.logic.init(data);
        }
        return initialState();
    }
    /** Submit a contract event and get updated state + result. */
    execute(event, state, data) {
        return this.logic.execute(event, { data, state, now: new Date() });
    }
}
//# sourceMappingURL=agent.js.map