import type { LLMClient } from "./llm.js";

export interface ReviewDecision {
  decision: "accept" | "reject" | "negotiate";
  reason: string;
  proposedTerms?: Record<string, unknown>;
}

export interface ServerReviewDecision {
  decision: "accept" | "counter_offer" | "reject";
  reason: string;
  /** Modified requirement fields to send back as a counter-offer */
  counterOffer?: Record<string, unknown>;
}

export interface AgentContractServerOptions {
  /** The contract requirements this server issues */
  requirements: import("@x490/protocol").ContractRequirements;
  /** Raw template text — gives Claude context about what the contract says */
  templateContent?: string;
  /** Anthropic API key — defaults to process.env.ANTHROPIC_API_KEY */
  apiKey?: string;
  /** Model to use for review. Default: claude-sonnet-4-6 */
  model?: string;
  /**
   * Called to issue a signed token once terms are agreed.
   * Receives the generated contractId and the accepting party's data.
   */
  issueToken: (contractId: string, partyData: Record<string, string>) => Promise<string>;
  /**
   * Called after Claude reviews proposed terms. Return to proceed, throw to abort.
   * If not provided, Claude's "reject" decision throws automatically.
   */
  onReview?: (decision: ServerReviewDecision, request: import("@x490/protocol").AcceptRequest) => Promise<void>;
  /** LLM client for driving negotiation decisions. Defaults to AnthropicClient. */
  llm?: LLMClient;
  /**
   * When true, fetches the selected variant's template from its URL for LLM review.
   * Only used when no templateContent is provided. Default: false.
   */
  fetchVariantTemplates?: boolean;
  /**
   * Called when clause edits are accepted to apply them to the document.
   * Receives the current template content and the proposed clause edits map
   * (clause id → proposed text). Must return the modified document and its
   * hex SHA-256 hash. Defaults to the built-in marker-based applyAndHash().
   */
  applyClauseEdits?: (
    templateContent: string,
    edits: Record<string, string>,
  ) => Promise<{ document: string; hash: string }>;
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
  /** LLM client for driving negotiation decisions. Defaults to AnthropicClient. */
  llm?: LLMClient;
  /** Extract text from binary documents (e.g. .docx, .pdf) for hash verification and LLM review. */
  extractText?: (content: ArrayBuffer, contentType: string, url: string) => Promise<string>;
}
