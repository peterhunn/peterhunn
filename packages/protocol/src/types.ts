/**
 * x490 — HTTP Contracting Protocol
 *
 * Wire types for the x490 protocol.
 * Extends x402 (payment) to add a legal agreement layer in the
 * agentic commerce stack: Discovery → [x490] → [x402] → Fulfillment
 */

/**
 * A single term the server is willing to negotiate.
 *
 * Servers enumerate negotiableFields inside ContractRequirements so that
 * clients — including AI agents — can discover exactly what is on the table
 * and what values are acceptable before making a proposal.
 */
export interface NegotiableField {
  /** Dot-path key that maps to a field in ContractRequirements or the contract data model */
  field: string;
  /**
   * Constrained set of values the server will accept for this field.
   * If absent, any value may be proposed (server decides at negotiation time).
   */
  allowedValues?: string[];
  /** Human/agent-readable explanation of what is negotiable and why */
  description: string;
}

/** A pre-authored document variant that parties may select during negotiation. */
export interface TemplateVariant {
  templateUrl: string;
  templateHash: string;
  description?: string;
}

/**
 * A named variable slot in the template document, denoted {{slotName}}.
 * Agents may propose values for these during negotiation.
 */
export interface TemplateVariable {
  description: string;
  defaultValue?: string;
  allowedValues?: string[];
  type?: "string" | "number" | "boolean" | "date";
}

/** Sent by the server in a 490 body and X-490-Requirements header. */
export interface ContractRequirements {
  scheme: "x490";
  version: 1;
  /** Accord Project-style class name, e.g. "org.accordproject.saas-msa" */
  templateId: string;
  /** URL where the client fetches the human+machine-readable template */
  templateUrl: string;
  /** Hex SHA-256 of the template content — client verifies before signing */
  templateHash: string;
  /** Fields the client must supply in AcceptRequest.partyData */
  requiredPartyFields: string[];
  jurisdiction?: string;
  governingLaw?: string;
  /** POST here to accept or propose modified terms */
  acceptEndpoint: string;
  /** POST here to negotiate specific terms before accepting */
  negotiateEndpoint?: string;
  /** Optional facilitator endpoint for offline-capable servers to delegate verification */
  verifyEndpoint?: string;
  /** POST here to revoke an agreement (e.g. on termination or breach) */
  revokeEndpoint?: string;
  /** Offer validity in seconds */
  expiresIn: number;
  /** Resource path being gated, or "*" for all paths on this origin */
  resource: string;
  description: string;
  /** Whether the server accepts negotiationTerms in AcceptRequest */
  negotiable: boolean;
  /**
   * Structured description of which fields may be negotiated and what values
   * are acceptable. Only meaningful when negotiable is true.
   *
   * Agents read this to construct informed proposals rather than guessing.
   * Servers use it to validate incoming negotiationTerms automatically.
   */
  negotiableFields?: NegotiableField[];
  /**
   * Number of distinct parties that must accept before a token is issued.
   * Defaults to 1 (single-party). When > 1, the first acceptor receives
   * status "pending" and a pendingContractId; subsequent parties co-sign
   * by including pendingContractId in their AcceptRequest.
   */
  requiredParties?: number;
  /**
   * Named pre-authored variants of this template that parties may select.
   * Each variant has its own URL and hash. Agents propose { variant: "<key>" }
   * in negotiationTerms to select one.
   */
  variants?: Record<string, TemplateVariant>;
  /**
   * Named variable slots in the template ({{slotName}} syntax).
   * Agents propose values for these in negotiationTerms.
   * The server validates values against allowedValues and renders the final document.
   */
  templateVariables?: Record<string, TemplateVariable>;
  /**
   * When true, agents may propose free-form edits to specific document clauses
   * via negotiationTerms.clauses. The server reviews changes with an LLM and
   * applies accepted edits using clause markers in the template.
   * Clause markers: <!-- clause:id -->text<!-- /clause:id -->
   */
  clauseEditing?: boolean;
}

/** Payload embedded inside an AgreementToken. */
export interface AgreementPayload {
  contractId: string;
  templateHash: string;
  partyId: string;
  /** Resource path this token is valid for, or "*" */
  resource: string;
  /** Issued-at (Unix seconds) */
  iat: number;
  /** Expires-at (Unix seconds) */
  exp: number;
}

/** Self-contained signed token. Carried in X-490-Contract header. */
export interface AgreementToken {
  scheme: "x490";
  payload: AgreementPayload;
  /** Hex HMAC-SHA256(secret, JSON.stringify(payload)) */
  signature: string;
}

/** Posted by the client to ContractRequirements.acceptEndpoint. */
export interface AcceptRequest {
  templateId: string;
  /** Must match ContractRequirements.templateHash */
  templateHash: string;
  /** Values keyed by ContractRequirements.requiredPartyFields */
  partyData: Record<string, string>;
  /** Proposed modifications — only sent when ContractRequirements.negotiable is true */
  negotiationTerms?: Record<string, unknown>;
  /**
   * For multi-party flows: the contractId returned by the first acceptor.
   * Subsequent parties include this to co-sign the same pending contract.
   */
  pendingContractId?: string;
}

/** Returned by the server from the acceptEndpoint. */
export interface AcceptResponse {
  /** "accepted" = token issued; "pending" = more parties needed; "counter_offer" = modified terms */
  status: "accepted" | "pending" | "counter_offer";
  contractId: string;
  /** base64(JSON(AgreementToken)) — present when status === "accepted" */
  token: string;
  /** Present when status === "counter_offer" */
  counterOffer?: ContractRequirements;
  /** How many parties have accepted so far (present when status === "pending") */
  pendingAcceptances?: number;
  /** Total parties required (present when status === "pending") */
  requiredAcceptances?: number;
  /**
   * Hex SHA-256 of the agreed document after clause edits have been applied.
   * Present when clauseEditing is true and clause changes were accepted.
   * Clients may fetch and verify the document independently using this hash.
   */
  agreementHash?: string;
}

/** Posted to verifyEndpoint by servers using the facilitator pattern. */
export interface VerifyRequest {
  token: string;
  resource: string;
}

/** Returned by the facilitator verify endpoint. */
export interface VerifyResponse {
  valid: boolean;
  contractId?: string;
  partyId?: string;
  expiresAt?: number;
  reason?: string;
}

/** Posted to revokeEndpoint to invalidate an active agreement token. */
export interface RevokeRequest {
  contractId: string;
  /** Reason string for audit log */
  reason?: string;
}

/** Returned by revokeEndpoint. */
export interface RevokeResponse {
  revoked: boolean;
  contractId: string;
}

// ── Discovery ─────────────────────────────────────────────────────────────────

/** A single contract resource advertised in a discovery document. */
export interface DiscoveryResource {
  /** Resource path being gated, or "*" for all paths */
  resource: string;
  /** Short human-readable label */
  description: string;
  /** Full ContractRequirements — agents can immediately start the flow */
  requirements: ContractRequirements;
}

/**
 * Served at GET /.well-known/x490.
 *
 * Enables agents to discover all contract gates on a server without
 * probing individual paths first. Analogue of /.well-known/oauth-authorization-server.
 */
export interface DiscoveryDocument {
  scheme: "x490";
  version: 1;
  /** Server origin, e.g. "https://api.example.com" */
  origin: string;
  /** All resources that may require an x490 contract agreement */
  resources: DiscoveryResource[];
}

// ── x402 integration ──────────────────────────────────────────────────────────

/** Minimal x402 payment requirement shape (scheme-agnostic fields we care about). */
export interface X402PaymentRequirement {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset?: string;
  extra?: Record<string, unknown>;
}

/**
 * Extended x402 402 response body.
 *
 * Servers that require both payment and a legal agreement embed
 * contractRequired alongside the standard x402 fields. x402-only clients
 * ignore the unknown field; x490-aware clients process both gates.
 */
export interface X402Response {
  x402Version: 1;
  accepts: X402PaymentRequirement[];
  /** x490 extension: present when a contract agreement is also required */
  contractRequired?: ContractRequirements;
  error: string | null;
}
