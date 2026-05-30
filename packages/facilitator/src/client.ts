import type { ContractRequirements, NegotiableField } from "@x490/protocol";
import type { AgreementRecord, AmendmentRecord, ContractEventRecord, RegisteredTemplate, TenantApiKey, WebhookDelivery, WebhookEventType } from "./types.js";

export interface FacilitatorClientOptions {
  /** API key from POST /v1/tenants or POST /v1/apikeys */
  apiKey: string;
  /** Tenant ID from POST /v1/tenants */
  tenantId: string;
  /** Facilitator base URL. Defaults to the hosted service. */
  baseUrl?: string;
}

export interface UploadResult {
  hash: string;
  url: string;
  title?: string;
  description?: string;
}

export interface TemplateSummary {
  hash: string;
  url: string;
  title?: string;
  description?: string;
  createdAt: number;
}

export interface TemplatePage {
  templates: TemplateSummary[];
  nextCursor: string | null;
}

export interface AgreementPage {
  agreements: AgreementRecord[];
  /** Opaque cursor — pass as `after` to fetch the next page. Null when no more pages. */
  nextCursor: string | null;
}

export interface EventPage {
  events: ContractEventRecord[];
  cursor?: string;
}

export interface AmendResult {
  amendment: AmendmentRecord;
  token: string;
}

export interface RenewResult {
  agreement: AgreementRecord;
  token: string;
}

export interface StatsResult {
  tenantId: string;
  webhooks: { total: number; active: number };
}

export interface HealthResult {
  status: "ok" | "degraded";
  timestamp: number;
  components?: Record<string, boolean>;
}

/**
 * TypeScript SDK for server operators integrating with the x490 managed facilitator.
 *
 * Usage:
 *   const facilitator = new FacilitatorClient({ apiKey, tenantId });
 *   const { hash } = await facilitator.uploadTemplate(ndaText, { title: "Data Use NDA" });
 *   const requirements = await facilitator.buildRequirements({
 *     templateHash: hash,
 *     requiredPartyFields: ["name", "jurisdiction"],
 *     resource: "/data",
 *     description: "Data Use NDA",
 *     expiresIn: 86400,  // 24 hours
 *   });
 */
export class FacilitatorClient {
  private readonly baseUrl: string;

  constructor(private readonly opts: FacilitatorClientOptions) {
    this.baseUrl = opts.baseUrl ?? "https://facilitator.x490.dev";
  }

  // ── Templates ────────────────────────────────────────────────────────────────

  /** Upload a contract template from a string. Returns its content-addressed hash and hosted URL. */
  async uploadTemplate(
    content: string,
    meta: { title?: string; description?: string } = {},
  ): Promise<UploadResult> {
    const res = await this.post("/v1/templates", { content, ...meta });
    if (!res.ok) throw new Error(`uploadTemplate failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<UploadResult>;
  }

  /**
   * Upload a contract template from a file buffer (PDF, DOCX, plain text, markdown).
   * Text is extracted server-side and registered as a template.
   */
  async uploadTemplateFile(
    file: Blob | File,
    opts: { title?: string; parentHash?: string; changeNote?: string } = {},
  ): Promise<UploadResult & { format: string; parentHash?: string }> {
    const form = new FormData();
    form.set("file", file, file instanceof File ? file.name : "document");
    if (opts.title) form.set("title", opts.title);
    if (opts.parentHash) form.set("parentHash", opts.parentHash);
    if (opts.changeNote) form.set("changeNote", opts.changeNote);
    const res = await this.postForm("/v1/templates/upload", form);
    if (!res.ok) throw new Error(`uploadTemplateFile failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<UploadResult & { format: string; parentHash?: string }>;
  }

  /** List templates for this tenant, newest first. */
  async listTemplates(opts: { limit?: number; after?: string } = {}): Promise<TemplatePage> {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set("limit", String(opts.limit));
    if (opts.after) qs.set("after", opts.after);
    const q = qs.toString();
    const res = await this.get(`/v1/templates${q ? `?${q}` : ""}`);
    if (!res.ok) throw new Error(`listTemplates failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<TemplatePage>;
  }

  /**
   * Register a new template version that supersedes an existing one.
   * The new template is immutably linked to the parent via parentHash.
   */
  async supersedeTemplate(
    parentHash: string,
    content: string,
    opts: { meta?: RegisteredTemplate["meta"]; terms?: RegisteredTemplate["terms"]; changeNote?: string } = {},
  ): Promise<RegisteredTemplate> {
    const res = await this.post(`/v1/templates/${parentHash}/supersede`, { content, ...opts });
    if (!res.ok) throw new Error(`supersedeTemplate failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<RegisteredTemplate>;
  }

  /**
   * Walk the version chain from the oldest ancestor up to (and including) the given hash.
   * Useful for displaying the full audit trail of template changes.
   */
  async getTemplateHistory(hash: string): Promise<RegisteredTemplate[]> {
    const res = await this.get(`/v1/templates/${hash}/history`);
    if (!res.ok) throw new Error(`getTemplateHistory failed: ${res.status} ${await res.text()}`);
    const { history } = await res.json() as { history: RegisteredTemplate[] };
    return history;
  }

  /** Return templates that directly supersede this hash (direct successors). */
  async getTemplateChildren(hash: string): Promise<RegisteredTemplate[]> {
    const res = await this.get(`/v1/templates/${hash}/children`);
    if (!res.ok) throw new Error(`getTemplateChildren failed: ${res.status} ${await res.text()}`);
    const { children } = await res.json() as { children: RegisteredTemplate[] };
    return children;
  }

  /**
   * Build ContractRequirements using a pre-registered template.
   *
   * The facilitator persists the expiresIn so tokens issued at accept time
   * use the correct TTL. Pass the returned object directly to
   * requireContract({ requirements, facilitated: true }).
   */
  async buildRequirements(opts: {
    templateHash: string;
    requiredPartyFields: string[];
    resource: string;
    description: string;
    expiresIn: number;
    negotiable?: boolean;
    negotiableFields?: NegotiableField[];
    requiredParties?: number;
    jurisdiction?: string;
    governingLaw?: string;
  }): Promise<ContractRequirements> {
    const res = await this.post("/v1/requirements", opts);
    if (!res.ok) throw new Error(`buildRequirements failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<ContractRequirements>;
  }

  // ── Agreements ───────────────────────────────────────────────────────────────

  /**
   * List agreements for your tenant.
   *
   * Returns one page of results. Use `page.nextCursor` with `after` to paginate:
   *
   *   let cursor: string | null = null;
   *   do {
   *     const page = await facilitator.listAgreements({ after: cursor ?? undefined });
   *     process(page.agreements);
   *     cursor = page.nextCursor;
   *   } while (cursor);
   */
  async listAgreements(
    filters: { resource?: string; limit?: number; after?: string } = {},
  ): Promise<AgreementPage> {
    const qs = new URLSearchParams();
    if (filters.resource) qs.set("resource", filters.resource);
    if (filters.limit) qs.set("limit", String(filters.limit));
    if (filters.after) qs.set("after", filters.after);
    const q = qs.toString();
    const res = await this.get(`/v1/agreements${q ? `?${q}` : ""}`);
    if (!res.ok) throw new Error(`listAgreements failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<AgreementPage>;
  }

  /** Get a single agreement by contractId. Returns null if not found. */
  async getAgreement(contractId: string): Promise<AgreementRecord | null> {
    const res = await this.get(`/v1/agreements/${contractId}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`getAgreement failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<AgreementRecord>;
  }

  /** Look up an agreement by its external (third-party) source and ID. Returns null if not found. */
  async getAgreementByExternalId(source: string, externalId: string): Promise<AgreementRecord | null> {
    const qs = new URLSearchParams({ source, externalId });
    const res = await this.get(`/v1/agreements/by-external?${qs}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`getAgreementByExternalId failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<AgreementRecord>;
  }

  /** Revoke an agreement. The token will be rejected by the verify endpoint immediately. */
  async revokeAgreement(contractId: string, reason?: string): Promise<void> {
    const res = await this.post(`/v1/${this.opts.tenantId}/revoke`, {
      contractId,
      ...(reason ? { reason } : {}),
    });
    if (!res.ok) throw new Error(`revokeAgreement failed: ${res.status} ${await res.text()}`);
  }

  /**
   * Amend an agreement in place — apply incremental changes to partyData
   * and issue a new superseding token without creating a new contractId.
   */
  async amendAgreement(
    contractId: string,
    opts: {
      changes: Record<string, string>;
      reason?: string;
      amendedBy?: string;
      expiresIn?: number;
    },
  ): Promise<AmendResult> {
    const res = await this.post(`/v1/agreements/${contractId}/amend`, opts);
    if (!res.ok) throw new Error(`amendAgreement failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<AmendResult>;
  }

  /** List all amendments for a contract, oldest first. */
  async listAmendments(contractId: string): Promise<AmendmentRecord[]> {
    const res = await this.get(`/v1/agreements/${contractId}/amendments`);
    if (!res.ok) throw new Error(`listAmendments failed: ${res.status} ${await res.text()}`);
    const { amendments } = await res.json() as { amendments: AmendmentRecord[] };
    return amendments;
  }

  /**
   * Renew an agreement — create a new contract that extends the same
   * template/resource/party relationship with a fresh TTL. The original
   * contractId remains valid until it naturally expires or is revoked.
   */
  async renewAgreement(
    contractId: string,
    opts: { expiresIn?: number; partyData?: Record<string, string> } = {},
  ): Promise<RenewResult> {
    const res = await this.post(`/v1/agreements/${contractId}/renew`, opts);
    if (!res.ok) throw new Error(`renewAgreement failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<RenewResult>;
  }

  // ── Contract event DAG ───────────────────────────────────────────────────────

  /**
   * Return the full causal event chain for a contract, ordered from root to tip.
   * Each event references its causal predecessors via parentEventIds.
   */
  async getAgreementEvents(contractId: string): Promise<ContractEventRecord[]> {
    const res = await this.get(`/v1/agreements/${contractId}/events`);
    if (!res.ok) throw new Error(`getAgreementEvents failed: ${res.status} ${await res.text()}`);
    const { events } = await res.json() as { events: ContractEventRecord[] };
    return events;
  }

  /**
   * Append a custom event to a contract's DAG.
   * Event types starting with "agreement." are reserved by the protocol.
   */
  async appendAgreementEvent(
    contractId: string,
    type: string,
    payload: Record<string, unknown> = {},
  ): Promise<ContractEventRecord> {
    const res = await this.post(`/v1/agreements/${contractId}/events`, { type, payload });
    if (!res.ok) throw new Error(`appendAgreementEvent failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<ContractEventRecord>;
  }

  /**
   * Tenant-wide event audit log, newest-first with cursor pagination.
   * Filter by resource or event type to narrow results.
   */
  async listEvents(
    opts: { limit?: number; cursor?: string; resource?: string; type?: string } = {},
  ): Promise<EventPage> {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set("limit", String(opts.limit));
    if (opts.cursor) qs.set("cursor", opts.cursor);
    if (opts.resource) qs.set("resource", opts.resource);
    if (opts.type) qs.set("type", opts.type);
    const q = qs.toString();
    const res = await this.get(`/v1/events${q ? `?${q}` : ""}`);
    if (!res.ok) throw new Error(`listEvents failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<EventPage>;
  }

  // ── API key management ───────────────────────────────────────────────────────

  /** List all API keys for the tenant (active and revoked). */
  async listApiKeys(): Promise<TenantApiKey[]> {
    const res = await this.get("/v1/apikeys");
    if (!res.ok) throw new Error(`listApiKeys failed: ${res.status} ${await res.text()}`);
    const { apiKeys } = await res.json() as { apiKeys: TenantApiKey[] };
    return apiKeys;
  }

  /**
   * Create an additional API key.
   * Returns the raw key — store it securely, it is shown exactly once.
   */
  async createApiKey(name: string): Promise<{ keyId: string; apiKey: string }> {
    const res = await this.post("/v1/apikeys", { name });
    if (!res.ok) throw new Error(`createApiKey failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<{ keyId: string; apiKey: string }>;
  }

  /** Revoke an API key by keyId. Does not affect other keys. */
  async revokeApiKey(keyId: string): Promise<void> {
    const res = await this.delete(`/v1/apikeys/${keyId}`);
    if (!res.ok) throw new Error(`revokeApiKey failed: ${res.status} ${await res.text()}`);
  }

  // ── Webhook management ───────────────────────────────────────────────────────

  /** List all registered webhooks (secrets are not included in responses). */
  async listWebhooks(): Promise<Omit<import("./types.js").Webhook, "secret">[]> {
    const res = await this.get("/v1/webhooks");
    if (!res.ok) throw new Error(`listWebhooks failed: ${res.status} ${await res.text()}`);
    const { webhooks } = await res.json() as { webhooks: Omit<import("./types.js").Webhook, "secret">[] };
    return webhooks;
  }

  /**
   * Register a webhook endpoint.
   * Returns the signing secret — store it securely, it is shown exactly once.
   * Use it to verify `X-X490-Signature` on incoming requests.
   */
  async createWebhook(url: string, events: WebhookEventType[]): Promise<{ webhookId: string; secret: string }> {
    const res = await this.post("/v1/webhooks", { url, events });
    if (!res.ok) throw new Error(`createWebhook failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<{ webhookId: string; secret: string }>;
  }

  /** Disable a webhook. It will no longer receive events. */
  async deleteWebhook(webhookId: string): Promise<void> {
    const res = await this.delete(`/v1/webhooks/${webhookId}`);
    if (!res.ok) throw new Error(`deleteWebhook failed: ${res.status} ${await res.text()}`);
  }

  /** List the most recent delivery attempts for a webhook (up to 50). */
  async listWebhookDeliveries(webhookId: string): Promise<WebhookDelivery[]> {
    const res = await this.get(`/v1/webhooks/${webhookId}/deliveries`);
    if (!res.ok) throw new Error(`listWebhookDeliveries failed: ${res.status} ${await res.text()}`);
    const { deliveries } = await res.json() as { deliveries: WebhookDelivery[] };
    return deliveries;
  }

  // ── Tenant & observability ───────────────────────────────────────────────────

  /** Return the tenantId and name for the authenticated API key. */
  async getMe(): Promise<{ tenantId: string; name: string }> {
    const res = await this.get("/v1/me");
    if (!res.ok) throw new Error(`getMe failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<{ tenantId: string; name: string }>;
  }

  /** Return webhook activity counts for this tenant. */
  async getStats(): Promise<StatsResult> {
    const res = await this.get("/v1/stats");
    if (!res.ok) throw new Error(`getStats failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<StatsResult>;
  }

  /**
   * Check facilitator health. Does not require authentication.
   * Returns 200 when all components are healthy, 503 when degraded.
   */
  async getHealth(): Promise<HealthResult> {
    const res = await fetch(`${this.baseUrl}/health`);
    return res.json() as Promise<HealthResult>;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private post(path: string, body: unknown): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": this.opts.apiKey },
      body: JSON.stringify(body),
    });
  }

  private postForm(path: string, form: FormData): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "X-API-Key": this.opts.apiKey },
      body: form,
    });
  }

  private get(path: string): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      headers: { "X-API-Key": this.opts.apiKey },
    });
  }

  private delete(path: string): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method: "DELETE",
      headers: { "X-API-Key": this.opts.apiKey },
    });
  }
}

/**
 * Sign up for the managed facilitator service.
 *
 * Call once to create your tenant. Store the returned apiKey securely —
 * it is shown exactly once and cannot be recovered.
 */
export async function signUp(
  name: string,
  baseUrl = "https://facilitator.x490.dev",
): Promise<{ tenantId: string; apiKey: string; keyId: string }> {
  const res = await fetch(`${baseUrl}/v1/tenants`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`signUp failed: ${res.status} ${await res.text()}`);
  const body = await res.json() as { tenantId: string; apiKey: string; keyId: string };
  return { tenantId: body.tenantId, apiKey: body.apiKey, keyId: body.keyId };
}
