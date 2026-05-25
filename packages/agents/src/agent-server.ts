import Anthropic from "@anthropic-ai/sdk";
import type { ContractRequirements, AcceptRequest, AcceptResponse } from "@x490/protocol";
import type { AgentContractServerOptions, ServerReviewDecision } from "./types.js";

/**
 * AgentContractServer — the issuing side of an agent-to-agent negotiation.
 *
 * Receives AcceptRequests from other agents, uses Claude to review any
 * proposed negotiation terms, and returns either an accepted token, a
 * counter-offer, or a rejection.
 *
 * Pair with AgentContractClient on the accepting side for a full A2A loop:
 *
 *   Server issues 490 challenge
 *   Client reviews with Claude → proposes terms
 *   Server reviews with Claude → accepts / counter-proposes / rejects
 *   Client reviews counter-offer with Claude → proposes again
 *   … up to maxNegotiationRounds on the client side
 */
export class AgentContractServer {
  private readonly anthropic: Anthropic;
  private readonly model: string;
  private readonly opts: AgentContractServerOptions;

  constructor(opts: AgentContractServerOptions) {
    this.opts = opts;
    this.model = opts.model ?? "claude-sonnet-4-6";
    this.anthropic = opts._anthropic ?? new Anthropic({ apiKey: opts.apiKey });
  }

  /**
   * Handle an AcceptRequest from another agent.
   *
   * - No negotiationTerms → issue token immediately (no Claude call).
   * - With negotiationTerms → Claude reviews → accept, counter-propose, or reject.
   */
  async handleAccept(request: AcceptRequest): Promise<AcceptResponse> {
    if (
      !request.negotiationTerms ||
      Object.keys(request.negotiationTerms).length === 0
    ) {
      return this.issueToken(request.partyData);
    }

    const decision = await this.claudeReview(request);

    if (this.opts.onReview) {
      await this.opts.onReview(decision, request);
    }

    if (decision.decision === "reject") {
      throw new Error(`AgentContractServer rejected negotiation: ${decision.reason}`);
    }

    if (decision.decision === "accept") {
      return this.issueToken(request.partyData);
    }

    // counter_offer — merge Claude's suggested changes onto the current requirements
    const counterOffer: ContractRequirements = {
      ...this.opts.requirements,
      ...(decision.counterOffer ?? {}),
    };
    return { status: "counter_offer", contractId: "", token: "", counterOffer };
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private async issueToken(partyData: Record<string, string>): Promise<AcceptResponse> {
    const contractId = crypto.randomUUID();
    const token = await this.opts.issueToken(contractId, partyData);
    return { status: "accepted", contractId, token };
  }

  private async claudeReview(request: AcceptRequest): Promise<ServerReviewDecision> {
    const { requirements, templateContent } = this.opts;

    const systemPrompt = `You are a contract issuer agent reviewing an acceptance request from another AI agent.
Review the proposed terms and decide: accept, counter_offer, or reject.
- Accept if proposed terms are fair and meet your core requirements.
- Counter-propose (counter_offer) if you can partially accommodate — return modified counterOffer fields.
- Reject only if the proposed terms fundamentally compromise the contract.
Respond with JSON only: { "decision": "accept"|"counter_offer"|"reject", "reason": "...", "counterOffer": { /* modified fields */ } }
counterOffer is only needed when decision is "counter_offer".`;

    const sections: string[] = [
      `YOUR CONTRACT REQUIREMENTS:\n${JSON.stringify(requirements, null, 2)}`,
    ];
    if (templateContent) {
      sections.push(`TEMPLATE:\n${templateContent}`);
    }
    sections.push(
      `PROPOSED TERMS FROM ACCEPTING AGENT:\n${JSON.stringify(request.negotiationTerms, null, 2)}`,
    );
    sections.push(`ACCEPTING AGENT PARTY DATA:\n${JSON.stringify(request.partyData, null, 2)}`);

    const message = await this.anthropic.beta.promptCaching.messages.create({
      model: this.model,
      max_tokens: 512,
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: sections.join("\n\n") }],
    });

    const text = message.content.find((b) => b.type === "text")?.text ?? "{}";
    try {
      return JSON.parse(text) as ServerReviewDecision;
    } catch {
      return { decision: "accept", reason: "Could not parse Claude response — defaulting to accept" };
    }
  }
}
