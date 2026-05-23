export interface ReviewDecision {
  decision: "accept" | "reject" | "negotiate";
  reason: string;
  proposedTerms?: Record<string, unknown>;
}

export interface AgentContractClientOptions {
  /** Anthropic API key — defaults to process.env.ANTHROPIC_API_KEY */
  apiKey?: string;
  /** Model to use for review. Default: claude-sonnet-4-6 */
  model?: string;
  /** Static party data or async resolver */
  partyData:
    | Record<string, string>
    | ((req: import("@x490/protocol").ContractRequirements) => Record<string, string> | Promise<Record<string, string>>);
  /** Max seconds before expiry to refresh token. Default: 60 */
  tokenRefreshThreshold?: number;
  /** Whether to call verifyEndpoint before using a cached token. Default: false */
  checkRevocationOnUse?: boolean;
  /** Called when a previously cached token is rejected by the server */
  onRevoked?: (contractId: string) => void | Promise<void>;
  /**
   * Called after Claude reviews requirements. Return to accept, throw to reject.
   * If not provided, Claude's "reject" decision throws automatically.
   */
  onReview?: (decision: ReviewDecision, requirements: import("@x490/protocol").ContractRequirements) => Promise<void>;
  /** Max negotiation rounds. Default: 3 */
  maxNegotiationRounds?: number;
  /** Skip template hash verification. Default: false */
  skipTemplateVerification?: boolean;
  /** @internal — for testing only */
  _anthropic?: import("@anthropic-ai/sdk").default;
}
