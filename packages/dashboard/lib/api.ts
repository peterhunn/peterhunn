import type { Auth } from "./auth";

async function apiFetch(auth: Auth, path: string, init?: RequestInit): Promise<Response> {
  const url = `${auth.baseUrl}${path}`;
  const headers = new Headers(init?.headers);
  headers.set("X-API-Key", auth.apiKey);
  if (!headers.has("Content-Type") && init?.body) headers.set("Content-Type", "application/json");
  return fetch(url, { ...init, headers });
}

export async function getMe(auth: Auth): Promise<{ tenantId: string; name: string }> {
  const res = await apiFetch(auth, "/v1/me");
  if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
  return res.json();
}

export async function listAgreements(auth: Auth, params: { resource?: string; after?: string; limit?: number } = {}) {
  const qs = new URLSearchParams();
  if (params.resource) qs.set("resource", params.resource);
  if (params.after) qs.set("after", params.after);
  if (params.limit) qs.set("limit", String(params.limit));
  const res = await apiFetch(auth, `/v1/agreements${qs.toString() ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ agreements: Agreement[]; nextCursor: string | null }>;
}

export async function revokeAgreement(auth: Auth, contractId: string, reason?: string) {
  const res = await apiFetch(auth, `/v1/${auth.tenantId}/revoke`, {
    method: "POST",
    body: JSON.stringify({ contractId, ...(reason ? { reason } : {}) }),
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function listApiKeys(auth: Auth) {
  const res = await apiFetch(auth, "/v1/apikeys");
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ apiKeys: ApiKey[] }>;
}

export async function createApiKey(auth: Auth, name: string) {
  const res = await apiFetch(auth, "/v1/apikeys", { method: "POST", body: JSON.stringify({ name }) });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ keyId: string; apiKey: string }>;
}

export async function revokeApiKey(auth: Auth, keyId: string) {
  const res = await apiFetch(auth, `/v1/apikeys/${keyId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await res.text());
}

export async function listWebhooks(auth: Auth) {
  const res = await apiFetch(auth, "/v1/webhooks");
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ webhooks: Webhook[] }>;
}

export async function createWebhook(auth: Auth, url: string, events: string[]) {
  const res = await apiFetch(auth, "/v1/webhooks", { method: "POST", body: JSON.stringify({ url, events }) });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ webhookId: string; secret: string; url: string; events: string[] }>;
}

export async function deleteWebhook(auth: Auth, webhookId: string) {
  const res = await apiFetch(auth, `/v1/webhooks/${webhookId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await res.text());
}

export interface Agreement {
  contractId: string; tenantId: string; templateHash: string;
  partyId: string; resource: string; partyData: Record<string, string>;
  issuedAt: number; expiresAt: number; revokedAt?: number; revokedReason?: string;
}
export interface ApiKey {
  keyId: string; tenantId: string; name: string;
  createdAt: number; revokedAt?: number;
}
export interface Webhook {
  webhookId: string; tenantId: string; url: string;
  events: string[]; active: boolean; createdAt: number;
}
