const BASE = "/api/facilitator";

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type") && init?.body) headers.set("Content-Type", "application/json");
  return fetch(`${BASE}${path}`, { ...init, headers });
}

export async function getMe(): Promise<{ tenantId: string; name: string }> {
  const res = await apiFetch("/v1/me");
  if (!res.ok) throw new Error(`Failed to load account: ${res.status}`);
  return res.json();
}

export async function listAgreements(
  params: { resource?: string; after?: string; limit?: number } = {},
): Promise<{ agreements: Agreement[]; nextCursor: string | null }> {
  const qs = new URLSearchParams();
  if (params.resource) qs.set("resource", params.resource);
  if (params.after) qs.set("after", params.after);
  if (params.limit) qs.set("limit", String(params.limit));
  const res = await apiFetch(`/v1/agreements${qs.toString() ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function revokeAgreement(
  tenantId: string,
  contractId: string,
  reason?: string,
): Promise<void> {
  const res = await apiFetch(`/v1/${tenantId}/revoke`, {
    method: "POST",
    body: JSON.stringify({ contractId, ...(reason ? { reason } : {}) }),
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function listApiKeys(): Promise<{ apiKeys: ApiKey[] }> {
  const res = await apiFetch("/v1/apikeys");
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createApiKey(name: string): Promise<{ keyId: string; apiKey: string }> {
  const res = await apiFetch("/v1/apikeys", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function revokeApiKey(keyId: string): Promise<void> {
  const res = await apiFetch(`/v1/apikeys/${keyId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await res.text());
}

export async function listWebhooks(): Promise<{ webhooks: Webhook[] }> {
  const res = await apiFetch("/v1/webhooks");
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createWebhook(
  url: string,
  events: string[],
): Promise<{ webhookId: string; secret: string; url: string; events: string[] }> {
  const res = await apiFetch("/v1/webhooks", {
    method: "POST",
    body: JSON.stringify({ url, events }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteWebhook(webhookId: string): Promise<void> {
  const res = await apiFetch(`/v1/webhooks/${webhookId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await res.text());
}

export async function listTemplates(
  params: { limit?: number; after?: string } = {},
): Promise<{ templates: Template[]; nextCursor: string | null }> {
  const qs = new URLSearchParams();
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.after) qs.set("after", params.after);
  const res = await apiFetch(`/v1/templates${qs.toString() ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function listContractEvents(contractId: string): Promise<{ events: ContractEvent[] }> {
  const res = await apiFetch(`/v1/agreements/${contractId}/events`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function buildRequirements(data: RequirementsInput): Promise<ContractRequirementsResponse> {
  const res = await apiFetch("/v1/requirements", {
    method: "POST",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function listWebhookDeliveries(webhookId: string): Promise<{ deliveries: WebhookDelivery[] }> {
  const res = await apiFetch(`/v1/webhooks/${webhookId}/deliveries`);
  if (!res.ok) {
    if (res.status === 404 || res.status === 503) return { deliveries: [] }; // endpoint may not exist yet
    throw new Error(await res.text());
  }
  return res.json();
}

export interface Agreement {
  contractId: string;
  tenantId: string;
  templateHash: string;
  partyId: string;
  resource: string;
  partyData: Record<string, string>;
  issuedAt: number;
  expiresAt: number;
  revokedAt?: number;
  revokedReason?: string;
}

export interface ApiKey {
  keyId: string;
  tenantId: string;
  name: string;
  createdAt: number;
  revokedAt?: number;
}

export interface Webhook {
  webhookId: string;
  tenantId: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: number;
}

export interface ContractTerms {
  liabilityCap?: string;
  governingLaw?: string;
  jurisdiction?: string;
  terminationNotice?: string;
  paymentTerms?: string;
  autoRenewal?: boolean;
  disputeResolution?: string;
  indemnification?: string;
  confidentiality?: string;
  extras?: Record<string, unknown>;
}

export interface Template {
  hash: string;
  url: string;
  title?: string;
  description?: string;
  terms?: ContractTerms;
  createdAt: number;
}

export interface ContractEvent {
  eventId: string;
  contractId: string;
  type: string;
  party?: string;
  payload: Record<string, unknown>;
  parentEventIds: string[];
  createdAt: number;
}

export interface RequirementsInput {
  templateHash: string;
  resource: string;
  description: string;
  expiresIn: number;
  requiredPartyFields: string[];
  negotiable?: boolean;
  negotiableFields?: Array<{ field: string; description: string; allowedValues?: string[] }>;
  requiredParties?: number;
  jurisdiction?: string;
  governingLaw?: string;
}

export interface ContractRequirementsResponse {
  scheme: "x490";
  version: 1;
  templateId: string;
  templateUrl: string;
  templateHash: string;
  requiredPartyFields: string[];
  acceptEndpoint: string;
  negotiateEndpoint?: string;
  verifyEndpoint?: string;
  revokeEndpoint?: string;
  expiresIn: number;
  resource: string;
  description: string;
  negotiable: boolean;
  negotiableFields?: Array<{ field: string; description: string; allowedValues?: string[] }>;
  requiredParties?: number;
  jurisdiction?: string;
  governingLaw?: string;
}

export interface WebhookDelivery {
  deliveryId: string;
  webhookId: string;
  eventType: string;
  contractId?: string;
  statusCode?: number;
  error?: string;
  attemptCount: number;
  succeededAt?: number;
  createdAt: number;
}

export interface PendingContractAcceptance {
  partyId: string;
  partyData: Record<string, string>;
  acceptedAt: number;
}

export interface PendingContract {
  contractId: string;
  tenantId: string;
  templateHash: string;
  requiredParties: number;
  acceptances: PendingContractAcceptance[];
  completedAt?: number;
  createdAt: number;
}

export async function listPendingContracts(): Promise<{ pendingContracts: PendingContract[] }> {
  const res = await apiFetch("/v1/pending-contracts");
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
