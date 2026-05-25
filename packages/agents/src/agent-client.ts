import Anthropic from "@anthropic-ai/sdk";
import { ContractClient } from "@x490/protocol";
import type { ContractRequirements, NegotiableField } from "@x490/protocol";
import type { AgentContractClientOptions, ReviewDecision } from "./types.js";
import { AnthropicClient } from "./llm.js";
import type { LLMClient } from "./llm.js";

export class AgentContractClient {
  private readonly inner: ContractClient;
  private readonly llm: LLMClient;
  private readonly opts: AgentContractClientOptions;

  constructor(opts: AgentContractClientOptions) {
    this.opts = opts;
    this.llm = opts.llm ?? new AnthropicClient(new Anthropic({ apiKey: opts.apiKey }), opts.model ?? "claude-sonnet-4-6");

    this.inner = new ContractClient({
      partyData: opts.partyData,
      onRequirements: this.reviewRequirements.bind(this),
      onNegotiation: this.proposeNegotiation.bind(this),
      ...(opts.tokenRefreshThreshold !== undefined ? { tokenRefreshThreshold: opts.tokenRefreshThreshold } : {}),
      ...(opts.checkRevocationOnUse !== undefined ? { checkRevocationOnUse: opts.checkRevocationOnUse } : {}),
      ...(opts.maxNegotiationRounds !== undefined ? { maxNegotiationRounds: opts.maxNegotiationRounds } : {}),
      ...(opts.skipTemplateVerification !== undefined ? { skipTemplateVerification: opts.skipTemplateVerification } : {}),
      ...(opts.onRevoked !== undefined ? { onRevoked: opts.onRevoked } : {}),
      ...(opts.extractText ? { extractText: opts.extractText } : {}),
    });
  }

  /** Drop-in for fetch — handles 490 contract gates automatically with Claude review */
  fetch(url: string, init?: RequestInit): Promise<Response> {
    return this.inner.fetch(url, init);
  }

  /** Establish an agreement directly (bypasses fetch) */
  establishAgreement(requirements: ContractRequirements): Promise<string> {
    return this.inner.establishAgreement(requirements);
  }

  private async reviewRequirements(requirements: ContractRequirements): Promise<void> {
    const decision = await this.claudeReview(requirements);

    if (this.opts.onReview) {
      await this.opts.onReview(decision, requirements);
      return;
    }

    if (decision.decision === "reject") {
      throw new Error(`x490 agent rejected contract: ${decision.reason}`);
    }
  }

  private async proposeNegotiation(requirements: ContractRequirements): Promise<Record<string, unknown> | undefined> {
    if (!requirements.negotiable || !requirements.negotiableFields?.length) return undefined;

    const decision = await this.claudeReview(requirements);
    return decision.proposedTerms;
  }

  private async claudeReview(requirements: ContractRequirements): Promise<ReviewDecision> {
    const systemPrompt = `You are a legal contract review agent for an automated system.
Review the contract requirements and decide: accept, reject, or negotiate.
- Accept if terms are standard and fair.
- Negotiate if the contract is negotiable and specific fields can be improved.
- Reject only if terms are clearly harmful or unacceptable.
Respond with JSON only: { "decision": "accept"|"reject"|"negotiate", "reason": "...", "proposedTerms": {...} }
proposedTerms is only needed when decision is "negotiate" — use field names from negotiableFields.
When variants are available, propose { "variant": "<key>" } in proposedTerms to select one.
When templateVariables are present, propose their values in proposedTerms.`;

    const sections: string[] = [
      `Contract requirements:\n${JSON.stringify(requirements, null, 2)}`,
    ];

    if (requirements.variants) {
      sections.push(
        `AVAILABLE VARIANTS:\n${Object.entries(requirements.variants)
          .map(([k, v]) => `- "${k}": ${v.description ?? k}`)
          .join("\n")}`,
      );
    }

    if (requirements.templateVariables) {
      sections.push(
        `TEMPLATE VARIABLES (negotiate values for these slots):\n${Object.entries(requirements.templateVariables)
          .map(([k, v]) =>
            `- ${k}: ${v.description}` +
            (v.defaultValue !== undefined ? ` (default: ${v.defaultValue})` : "") +
            (v.allowedValues ? ` (allowed: ${v.allowedValues.join(", ")})` : ""),
          )
          .join("\n")}`,
      );
    }

    const result = await this.llm.complete(systemPrompt, [{ role: "user", content: sections.join("\n\n") }]);

    try {
      return JSON.parse(result.content) as ReviewDecision;
    } catch {
      return { decision: "accept", reason: "Could not parse Claude response — defaulting to accept" };
    }
  }
}
