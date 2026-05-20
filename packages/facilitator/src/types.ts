/**
 * Facilitator-internal types.
 *
 * These are NOT part of the x490 wire protocol — they are the managed service's
 * own data model. The wire protocol types live in @x490/protocol.
 */

/** A server operator that has signed up for the managed facilitator service. */
export interface Tenant {
  tenantId: string;
  /** Random secret used to sign x490 tokens for this tenant. Never exposed. */
  hmacSecret: string;
  name: string;
  createdAt: number;
}

/**
 * An API key belonging to a tenant.
 * Tenants may have multiple active keys (e.g., production + staging).
 * Keys may be rotated independently without affecting other keys or the tenant.
 */
export interface TenantApiKey {
  keyId: string;
  tenantId: string;
  /** sha256(rawApiKey) — raw key shown once, never stored */
  keyHash: string;
  /** Human label, e.g. "production" or "ci" */
  name: string;
  createdAt: number;
  revokedAt?: number;
}

/** A contract template registered by a tenant and hosted by the facilitator. */
export interface RegisteredTemplate {
  /** hex SHA-256 of content — content-addressed, doubles as stable identifier */
  hash: string;
  tenantId: string;
  /** Raw template text with {{variable}} placeholders */
  content: string;
  meta: {
    title?: string;
    description?: string;
  };
  /** Structured clause data provided by the operator at registration time. */
  terms?: import("@x490/core").ContractTerms;
  createdAt: number;
}

/**
 * Stored requirements config — persisted when the operator calls buildRequirements.
 * Lets the accept endpoint use the correct expiresIn per (tenant, template, resource).
 */
export interface RequirementsConfig {
  id: string;
  tenantId: string;
  templateHash: string;
  resource: string;
  expiresIn: number;
  requiredPartyFields: string[];
  negotiable?: boolean;
  negotiableFields?: import("@x490/protocol").NegotiableField[];
  requiredParties?: number;
  createdAt: number;
}

export interface PendingContract {
  contractId: string;
  tenantId: string;
  templateHash: string;
  requiredParties: number;
  acceptances: Array<{ partyId: string; partyData: Record<string, string>; acceptedAt: number }>;
  completedAt?: number;
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

/**
 * A contract lifecycle event stored in the event DAG.
 * Each event references its causal parents via parentEventIds,
 * forming a directed acyclic graph that captures the full causal history
 * of an agreement (accepted → amended → revoked, or parallel multi-party events).
 */
export interface ContractEventRecord {
  eventId: string;
  contractId: string;
  tenantId: string;
  /** Event type — protocol-defined ("agreement.accepted", "agreement.revoked")
   *  or operator-defined custom event types. */
  type: string;
  /** partyId of the party that triggered this event, if applicable. */
  party?: string;
  payload: Record<string, unknown>;
  /** DAG edges — IDs of events that causally precede this one.
   *  Empty array means this is a root event. */
  parentEventIds: string[];
  createdAt: number;
}

// ── Webhooks ───────────────────────────────────────────────────────────────────

export type WebhookEventType = "agreement.created" | "agreement.revoked";

/**
 * A webhook endpoint registered by an operator.
 * The signing secret is shown once at creation and stored for outbound signing.
 */
export interface Webhook {
  webhookId: string;
  tenantId: string;
  url: string;
  /** Plaintext — used server-side to sign outgoing payloads. Never sent in responses. */
  secret: string;
  events: WebhookEventType[];
  active: boolean;
  createdAt: number;
}

/** The JSON body POSTed to an operator's webhook URL. */
export interface WebhookPayload {
  eventId: string;
  type: WebhookEventType;
  createdAt: number;
  tenantId: string;
  /** Agreement data without the raw token. */
  data: Omit<AgreementRecord, "token">;
}

export interface WebhookDelivery {
  deliveryId: string;
  webhookId: string;
  tenantId: string;
  eventType: string;
  contractId?: string;
  statusCode?: number;
  error?: string;
  attemptCount: number;
  succeededAt?: number;
  createdAt: number;
}
