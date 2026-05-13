/**
 * Facilitator-internal types.
 *
 * These are NOT part of the x490 wire protocol — they are the managed service's
 * own data model. The wire protocol types live in @x490/protocol.
 */

/** A server operator that has signed up for the managed facilitator service. */
export interface Tenant {
  tenantId: string;
  /** sha256(apiKey) — raw key is shown once and never stored */
  apiKeyHash: string;
  /** Random secret used to sign x490 tokens for this tenant. Never exposed. */
  hmacSecret: string;
  name: string;
  createdAt: number;
}

/** A contract template registered by a tenant and hosted by the facilitator. */
export interface RegisteredTemplate {
  /** hex SHA-256 of content — content-addressed, doubles as stable identifier */
  hash: string;
  tenantId: string;
  /** Raw template text (Markdown with {{variable}} placeholders) */
  content: string;
  meta: {
    title?: string;
    description?: string;
  };
  createdAt: number;
}

/** A signed agreement recorded after an agent accepts a contract. */
export interface AgreementRecord {
  contractId: string;
  tenantId: string;
  templateHash: string;
  partyId: string;
  resource: string;
  partyData: Record<string, string>;
  token: string;
  issuedAt: number;
  expiresAt: number;
  revokedAt?: number;
  revokedReason?: string;
}

export function isRevoked(record: AgreementRecord): boolean {
  return record.revokedAt !== undefined;
}
