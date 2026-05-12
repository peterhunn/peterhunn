/**
 * LAP/1.0 — Legal Agents Protocol
 *
 * Wire types for the HTTP contracting protocol.
 * Extends x402 (payment) to add a legal agreement layer in the
 * agentic commerce stack: Discovery → [LAP] → [x402] → Fulfillment
 */

/** Sent by the server in a 403 body and X-Contract-Requirements header. */
export interface ContractRequirements {
  scheme: "legal-agents/v1";
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
  /** Optional facilitator endpoint for offline-capable servers to delegate verification */
  verifyEndpoint?: string;
  /** Offer validity in seconds */
  expiresIn: number;
  /** Resource path being gated, or "*" for all paths on this origin */
  resource: string;
  description: string;
  /** Whether the server accepts negotiationTerms in AcceptRequest */
  negotiable: boolean;
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

/** Self-contained signed token. Carried in X-Contract-Agreement header. */
export interface AgreementToken {
  scheme: "legal-agents/v1";
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
}

/** Returned by the server from the acceptEndpoint. */
export interface AcceptResponse {
  status: "accepted" | "counter_offer";
  contractId: string;
  /** base64(JSON(AgreementToken)) — present when status === "accepted" */
  token: string;
  /** Present when status === "counter_offer" */
  counterOffer?: ContractRequirements;
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
 * ignore the unknown field; LAP-aware clients process both gates.
 */
export interface X402Response {
  x402Version: 1;
  accepts: X402PaymentRequirement[];
  /** LAP extension: present when a contract agreement is also required */
  contractRequired?: ContractRequirements;
  error: string | null;
}
