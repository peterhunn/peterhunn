import Anthropic from "@anthropic-ai/sdk";
import { ContractClient } from "@x490/protocol";
import type { ContractRequirements, NegotiableField } from "@x490/protocol";
import type { AgentContractClientOptions, ReviewDecision } from "./types.js";

export class AgentContractClient {
  private readonly inner: ContractClient;
  private readonly anthropic: Anthropic;
  private readonly model: string;
  private readonly opts: AgentContractClientOptions;

  constructor(opts: AgentContractClientOptions) {
    this.opts = opts;
    this.model = opts.model ?? "claude-sonnet-4-6";
    this.anthropic = opts._anthropic ?? new Anthropic({ apiKey: opts.apiKey });

    this.inner = new ContractClient({
      partyData: opts.partyData,
      onRequirements: this.reviewRequirements.bind(this),
      onNegotiation: this.proposeNegotiation.bind(this),
      ...(opts.tokenRefreshThreshold !== undefined ? { tokenRefreshThreshold: opts.tokenRefreshThreshold } : {}),
      ...(opts.checkRevocationOnUse !== undefined ? { checkRevocationOnUse: opts.checkRevocationOnUse } : {}),
      ...(opts.maxNegotiationRounds !== undefined ? { maxNegotiationRounds: opts.maxNegotiationRounds } : {}),
      ...(opts.skipTemplateVerification !== undefined ? { skipTemplateVerification: opts.skipTemplateVerification } : {}),
      ...(opts.onRevoked !== undefined ? { onRevoked: opts.onRevoked } : {}),
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
proposedTerms is only needed when decision is "negotiate" — use field names from negotiableFields.`;

    const userContent = `Contract requirements:\n${JSON.stringify(requirements, null, 2)}`;

    const message = await this.anthropic.beta.promptCaching.messages.create({
      model: this.model,
      max_tokens: 512,
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: userContent }],
    });

    const text = message.content.find((b) => b.type === "text")?.text ?? "{}";
    try {
      return JSON.parse(text) as ReviewDecision;
    } catch {
      return { decision: "accept", reason: "Could not parse Claude response — defaulting to accept" };
    }
  }
}
