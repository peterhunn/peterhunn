import type { Tenant, TenantApiKey, RegisteredTemplate, AgreementRecord, AmendmentRecord, RequirementsConfig, Webhook, WebhookEventType, ContractEventRecord, PendingContract, WebhookDelivery } from "./types.js";

// ── Crypto helpers ─────────────────────────────────────────────────────────────

export async function sha256hex(content: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function generateApiKey(): Promise<{ raw: string; hash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const raw = `sk_x490_${hex}`;
  return { raw, hash: await sha256hex(raw) };
}

function generateHmacSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Store interfaces ───────────────────────────────────────────────────────────

export interface TenantStore {
  /** Create a tenant and its first API key. */
  create(name: string): Promise<{ tenant: Tenant; rawApiKey: string; keyId: string }>;
  findById(tenantId: string): Promise<Tenant | null>;
  /** O(1) lookup via hash index — does not return revoked keys. */
  findByApiKey(raw: string): Promise<Tenant | null>;
  /** Find or auto-provision a tenant keyed to an Auth0 subject claim. */
  findOrCreateByAuth0Sub(sub: string): Promise<Tenant>;
  /** Create an additional API key for an existing tenant. */
  createApiKey(tenantId: string, name: string): Promise<{ keyId: string; rawApiKey: string }>;
  listApiKeys(tenantId: string): Promise<TenantApiKey[]>;
  revokeApiKey(keyId: string): Promise<boolean>;
  delete(tenantId: string): Promise<boolean>;
}

export interface TemplateStore {
  register(
    tenantId: string,
    content: string,
    meta: RegisteredTemplate["meta"],
    terms?: RegisteredTemplate["terms"],
    parentHash?: string,
    changeNote?: string,
  ): Promise<RegisteredTemplate>;
  findByHash(hash: string): Promise<RegisteredTemplate | null>;
  listByTenant(tenantId: string, opts?: { limit?: number; after?: string }): Promise<{
    templates: RegisteredTemplate[];
    nextCursor: string | null;
  }>;
  /** Returns the version chain from the oldest ancestor to the given hash (inclusive). */
  getHistory(hash: string): Promise<RegisteredTemplate[]>;
  /** Returns templates that list this hash as their parentHash (direct successors). */
  getChildren(hash: string): Promise<RegisteredTemplate[]>;
}

export interface RequirementsStore {
  /** Upsert a requirements config keyed by (tenantId, templateHash, resource). */
  upsert(config: Omit<RequirementsConfig, "id" | "createdAt">): Promise<RequirementsConfig>;
  /** Find the requirements config with the highest expiresIn for a given template. */
  findByTemplate(tenantId: string, templateHash: string): Promise<RequirementsConfig | null>;
  findByResource(tenantId: string, templateHash: string, resource: string): Promise<RequirementsConfig | null>;
}

export interface AgreementStore {
  record(agreement: AgreementRecord): Promise<void>;
  findById(contractId: string): Promise<AgreementRecord | null>;
  findByExternalId(tenantId: string, source: string, externalId: string): Promise<AgreementRecord | null>;
  listByTenant(tenantId: string, opts?: { resource?: string; limit?: number; after?: string }): Promise<{
    agreements: AgreementRecord[];
    nextCursor: string | null;
  }>;
  revoke(contractId: string, reason?: string): Promise<boolean>;
  isRevoked(contractId: string): Promise<boolean>;
  /** Record an amendment to an existing agreement. */
  recordAmendment(amendment: AmendmentRecord): Promise<void>;
  /** List all amendments for a contract, oldest first. */
  listAmendments(contractId: string): Promise<AmendmentRecord[]>;
  /**
   * Find active (non-revoked) agreements expiring between afterUnix and beforeUnix.
   * Used by the expiry scheduler to send warning notifications.
   */
  findExpiringBetween(afterUnix: number, beforeUnix: number, limit?: number): Promise<AgreementRecord[]>;
}

// ── In-memory implementations ──────────────────────────────────────────────────

export class InMemoryTenantStore implements TenantStore {
  private readonly tenants = new Map<string, Tenant>();
  private readonly apiKeys = new Map<string, TenantApiKey>(); // keyId → key
  private readonly keyHashIndex = new Map<string, string>(); // sha256(raw) → keyId
  private readonly auth0SubIndex = new Map<string, string>(); // auth0 sub → tenantId

  async create(name: string): Promise<{ tenant: Tenant; rawApiKey: string; keyId: string }> {
    const { raw, hash } = await generateApiKey();
    const tenant: Tenant = {
      tenantId: crypto.randomUUID(),
      hmacSecret: generateHmacSecret(),
      name,
      createdAt: Math.floor(Date.now() / 1000),
    };
    this.tenants.set(tenant.tenantId, tenant);

    const key: TenantApiKey = {
      keyId: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      keyHash: hash,
      name: "default",
      createdAt: tenant.createdAt,
    };
    this.apiKeys.set(key.keyId, key);
    this.keyHashIndex.set(hash, key.keyId);

    return { tenant, rawApiKey: raw, keyId: key.keyId };
  }

  async findByApiKey(raw: string): Promise<Tenant | null> {
    const hash = await sha256hex(raw);
    const keyId = this.keyHashIndex.get(hash);
    if (!keyId) return null;
    const key = this.apiKeys.get(keyId);
    if (!key || key.revokedAt !== undefined) return null;
    return this.tenants.get(key.tenantId) ?? null;
  }

  async findById(tenantId: string): Promise<Tenant | null> {
    return this.tenants.get(tenantId) ?? null;
  }

  async findOrCreateByAuth0Sub(sub: string): Promise<Tenant> {
    const existingId = this.auth0SubIndex.get(sub);
    if (existingId) return this.tenants.get(existingId)!;

    const tenant: Tenant = {
      tenantId: crypto.randomUUID(),
      hmacSecret: generateHmacSecret(),
      name: sub,
      createdAt: Math.floor(Date.now() / 1000),
    };
    this.tenants.set(tenant.tenantId, tenant);
    this.auth0SubIndex.set(sub, tenant.tenantId);
    return tenant;
  }

  async createApiKey(tenantId: string, name: string): Promise<{ keyId: string; rawApiKey: string }> {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) throw new Error("Tenant not found");
    const { raw, hash } = await generateApiKey();
    const key: TenantApiKey = {
      keyId: crypto.randomUUID(),
      tenantId,
      keyHash: hash,
      name,
      createdAt: Math.floor(Date.now() / 1000),
    };
    this.apiKeys.set(key.keyId, key);
    this.keyHashIndex.set(hash, key.keyId);
    return { keyId: key.keyId, rawApiKey: raw };
  }

  async listApiKeys(tenantId: string): Promise<TenantApiKey[]> {
    return [...this.apiKeys.values()].filter((k) => k.tenantId === tenantId);
  }

  async revokeApiKey(keyId: string): Promise<boolean> {
    const key = this.apiKeys.get(keyId);
    if (!key) return false;
    this.apiKeys.set(keyId, { ...key, revokedAt: Math.floor(Date.now() / 1000) });
    this.keyHashIndex.delete(key.keyHash);
    return true;
  }

  async delete(tenantId: string): Promise<boolean> {
    if (!this.tenants.has(tenantId)) return false;
    this.tenants.delete(tenantId);
    // Remove all API keys for this tenant from both indexes.
    for (const [keyId, key] of this.apiKeys) {
      if (key.tenantId === tenantId) {
        this.keyHashIndex.delete(key.keyHash);
        this.apiKeys.delete(keyId);
      }
    }
    // Remove from auth0 sub index.
    for (const [sub, tid] of this.auth0SubIndex) {
      if (tid === tenantId) this.auth0SubIndex.delete(sub);
    }
    return true;
  }
}

export class InMemoryTemplateStore implements TemplateStore {
  private readonly templates = new Map<string, RegisteredTemplate>();

  async register(
    tenantId: string,
    content: string,
    meta: RegisteredTemplate["meta"],
    terms?: RegisteredTemplate["terms"],
    parentHash?: string,
    changeNote?: string,
  ): Promise<RegisteredTemplate> {
    const hash = await sha256hex(content);
    const existing = this.templates.get(hash);
    if (existing) return existing;

    const tmpl: RegisteredTemplate = {
      hash,
      tenantId,
      content,
      meta,
      ...(terms ? { terms } : {}),
      ...(parentHash ? { parentHash } : {}),
      ...(changeNote ? { changeNote } : {}),
      createdAt: Math.floor(Date.now() / 1000),
    };
    this.templates.set(hash, tmpl);
    return tmpl;
  }

  async findByHash(hash: string): Promise<RegisteredTemplate | null> {
    return this.templates.get(hash) ?? null;
  }

  async listByTenant(
    tenantId: string,
    opts: { limit?: number; after?: string } = {},
  ): Promise<{ templates: RegisteredTemplate[]; nextCursor: string | null }> {
    const limit = Math.min(opts.limit ?? 50, 200);
    let records = [...this.templates.values()]
      .filter((t) => t.tenantId === tenantId)
      .sort((a, b) => b.createdAt - a.createdAt || a.hash.localeCompare(b.hash));

    if (opts.after) {
      const [afterTs, afterHash] = decodeCursor(opts.after);
      records = records.filter(
        (t) => t.createdAt < afterTs || (t.createdAt === afterTs && t.hash > afterHash),
      );
    }

    const page = records.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = page.length === limit && last
      ? encodeCursor(last.createdAt, last.hash)
      : null;
    return { templates: page, nextCursor };
  }

  async getHistory(hash: string): Promise<RegisteredTemplate[]> {
    const chain: RegisteredTemplate[] = [];
    let current = this.templates.get(hash);
    while (current) {
      chain.unshift(current); // oldest first
      current = current.parentHash ? this.templates.get(current.parentHash) : undefined;
    }
    return chain;
  }

  async getChildren(hash: string): Promise<RegisteredTemplate[]> {
    return [...this.templates.values()].filter((t) => t.parentHash === hash);
  }
}

export class InMemoryRequirementsStore implements RequirementsStore {
  private readonly configs = new Map<string, RequirementsConfig>(); // id → config

  private key(tenantId: string, templateHash: string, resource: string): string {
    return `${tenantId}:${templateHash}:${resource}`;
  }

  async upsert(config: Omit<RequirementsConfig, "id" | "createdAt">): Promise<RequirementsConfig> {
    // Find existing by composite key
    const compositeKey = this.key(config.tenantId, config.templateHash, config.resource);
    for (const existing of this.configs.values()) {
      if (this.key(existing.tenantId, existing.templateHash, existing.resource) === compositeKey) {
        const updated: RequirementsConfig = { ...existing, ...config };
        this.configs.set(existing.id, updated);
        return updated;
      }
    }
    const record: RequirementsConfig = {
      ...config,
      id: crypto.randomUUID(),
      createdAt: Math.floor(Date.now() / 1000),
    };
    this.configs.set(record.id, record);
    return record;
  }

  async findByTemplate(tenantId: string, templateHash: string): Promise<RequirementsConfig | null> {
    let best: RequirementsConfig | null = null;
    for (const c of this.configs.values()) {
      if (c.tenantId === tenantId && c.templateHash === templateHash) {
        if (!best || c.expiresIn > best.expiresIn) best = c;
      }
    }
    return best;
  }

  async findByResource(tenantId: string, templateHash: string, resource: string): Promise<RequirementsConfig | null> {
    for (const c of this.configs.values()) {
      if (c.tenantId === tenantId && c.templateHash === templateHash && c.resource === resource) {
        return c;
      }
    }
    return null;
  }
}

export class InMemoryAgreementStore implements AgreementStore {
  private readonly agreements = new Map<string, AgreementRecord>();
  private readonly amendments = new Map<string, AmendmentRecord[]>();

  async record(agreement: AgreementRecord): Promise<void> {
    this.agreements.set(agreement.contractId, agreement);
  }

  async findById(contractId: string): Promise<AgreementRecord | null> {
    return this.agreements.get(contractId) ?? null;
  }

  async findByExternalId(tenantId: string, source: string, externalId: string): Promise<AgreementRecord | null> {
    for (const record of this.agreements.values()) {
      if (record.tenantId === tenantId && record.externalSource === source && record.externalId === externalId) {
        return record;
      }
    }
    return null;
  }

  async listByTenant(
    tenantId: string,
    opts: { resource?: string; limit?: number; after?: string } = {},
  ): Promise<{ agreements: AgreementRecord[]; nextCursor: string | null }> {
    const limit = Math.min(opts.limit ?? 50, 200);

    let records = [...this.agreements.values()]
      .filter((a) => a.tenantId === tenantId)
      .filter((a) => !opts.resource || a.resource === opts.resource || a.resource === "*")
      .sort((a, b) => b.issuedAt - a.issuedAt || a.contractId.localeCompare(b.contractId));

    if (opts.after) {
      const [afterTs, afterId] = decodeCursor(opts.after);
      records = records.filter(
        (a) => a.issuedAt < afterTs || (a.issuedAt === afterTs && a.contractId > afterId),
      );
    }

    const page = records.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = page.length === limit && last
      ? encodeCursor(last.issuedAt, last.contractId)
      : null;

    return { agreements: page, nextCursor };
  }

  async revoke(contractId: string, reason?: string): Promise<boolean> {
    const record = this.agreements.get(contractId);
    if (!record) return false;
    const updated: AgreementRecord = {
      ...record,
      revokedAt: Math.floor(Date.now() / 1000),
      ...(reason !== undefined ? { revokedReason: reason } : {}),
    };
    this.agreements.set(contractId, updated);
    return true;
  }

  async isRevoked(contractId: string): Promise<boolean> {
    return this.agreements.get(contractId)?.revokedAt !== undefined;
  }

  async recordAmendment(amendment: AmendmentRecord): Promise<void> {
    const list = this.amendments.get(amendment.contractId) ?? [];
    list.push(amendment);
    this.amendments.set(amendment.contractId, list);
  }

  async listAmendments(contractId: string): Promise<AmendmentRecord[]> {
    return [...(this.amendments.get(contractId) ?? [])];
  }

  async findExpiringBetween(afterUnix: number, beforeUnix: number, limit = 200): Promise<AgreementRecord[]> {
    const results: AgreementRecord[] = [];
    for (const a of this.agreements.values()) {
      if (!a.revokedAt && a.expiresAt > afterUnix && a.expiresAt <= beforeUnix) {
        results.push(a);
        if (results.length >= limit) break;
      }
    }
    return results;
  }
}

// ── Pending contract store ─────────────────────────────────────────────────────

export interface PendingContractStore {
  create(entry: Omit<PendingContract, "acceptances" | "createdAt">): Promise<PendingContract>;
  addParty(contractId: string, partyId: string, partyData: Record<string, string>): Promise<PendingContract | null>;
  get(contractId: string): Promise<PendingContract | null>;
  complete(contractId: string): Promise<void>;
  /** List all pending (completedAt is null) contracts for a tenant. */
  listByTenant(tenantId: string): Promise<PendingContract[]>;
}

export class InMemoryPendingContractStore implements PendingContractStore {
  private readonly contracts = new Map<string, PendingContract>();

  async create(entry: Omit<PendingContract, "acceptances" | "createdAt">): Promise<PendingContract> {
    const contract: PendingContract = {
      ...entry,
      acceptances: [],
      createdAt: Math.floor(Date.now() / 1000),
    };
    this.contracts.set(contract.contractId, contract);
    return contract;
  }

  async addParty(contractId: string, partyId: string, partyData: Record<string, string>): Promise<PendingContract | null> {
    const contract = this.contracts.get(contractId);
    if (!contract || contract.completedAt !== undefined) return null;
    const updated: PendingContract = {
      ...contract,
      acceptances: [
        ...contract.acceptances,
        { partyId, partyData, acceptedAt: Math.floor(Date.now() / 1000) },
      ],
    };
    this.contracts.set(contractId, updated);
    return updated;
  }

  async get(contractId: string): Promise<PendingContract | null> {
    const c = this.contracts.get(contractId);
    if (!c || c.completedAt !== undefined) return null;
    return c;
  }

  async complete(contractId: string): Promise<void> {
    const c = this.contracts.get(contractId);
    if (c) this.contracts.set(contractId, { ...c, completedAt: Math.floor(Date.now() / 1000) });
  }

  async listByTenant(tenantId: string): Promise<PendingContract[]> {
    return [...this.contracts.values()]
      .filter((c) => c.tenantId === tenantId && c.completedAt === undefined)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
}

// ── Cursor helpers ─────────────────────────────────────────────────────────────

export function encodeCursor(issuedAt: number, contractId: string): string {
  return Buffer.from(`${issuedAt}:${contractId}`).toString("base64url");
}

export function decodeCursor(cursor: string): [number, string] {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const idx = decoded.indexOf(":");
  return [Number(decoded.slice(0, idx)), decoded.slice(idx + 1)];
}

// ── Webhook store ──────────────────────────────────────────────────────────────

export interface WebhookStore {
  create(tenantId: string, url: string, events: WebhookEventType[]): Promise<{ webhook: Webhook; secret: string }>;
  list(tenantId: string): Promise<Webhook[]>;
  findById(webhookId: string): Promise<Webhook | null>;
  disable(webhookId: string): Promise<void>;
  /** Return only active webhooks subscribed to this event type. */
  listActiveForEvent(tenantId: string, event: WebhookEventType): Promise<Webhook[]>;
}

function generateWebhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class InMemoryWebhookStore implements WebhookStore {
  private readonly hooks = new Map<string, Webhook>();

  async create(tenantId: string, url: string, events: WebhookEventType[]): Promise<{ webhook: Webhook; secret: string }> {
    const secret = generateWebhookSecret();
    const webhook: Webhook = {
      webhookId: crypto.randomUUID(),
      tenantId,
      url,
      secret,
      events,
      active: true,
      createdAt: Math.floor(Date.now() / 1000),
    };
    this.hooks.set(webhook.webhookId, webhook);
    return { webhook, secret };
  }

  async list(tenantId: string): Promise<Webhook[]> {
    return [...this.hooks.values()].filter((h) => h.tenantId === tenantId);
  }

  async findById(webhookId: string): Promise<Webhook | null> {
    return this.hooks.get(webhookId) ?? null;
  }

  async disable(webhookId: string): Promise<void> {
    const hook = this.hooks.get(webhookId);
    if (hook) this.hooks.set(webhookId, { ...hook, active: false });
  }

  async listActiveForEvent(tenantId: string, event: WebhookEventType): Promise<Webhook[]> {
    return [...this.hooks.values()].filter(
      (h) => h.tenantId === tenantId && h.active && h.events.includes(event),
    );
  }
}

// ── Event store ────────────────────────────────────────────────────────────────

export interface EventStore {
  append(event: ContractEventRecord): Promise<void>;
  listByContract(contractId: string): Promise<ContractEventRecord[]>;
  /** ID of the most recently appended event for this contract, or null. */
  latestEventId(contractId: string): Promise<string | null>;
  /** List events across all contracts for a tenant (audit log). */
  listByTenant(
    tenantId: string,
    opts: { limit: number; cursor?: string; resource?: string; type?: string },
  ): Promise<{ events: ContractEventRecord[]; cursor?: string }>;
}

export class InMemoryEventStore implements EventStore {
  private readonly events = new Map<string, ContractEventRecord>(); // eventId → event
  private readonly byContract = new Map<string, string[]>();        // contractId → eventIds (ordered)
  private readonly contractResource = new Map<string, string>();    // contractId → resource (for filter)

  constructor(private readonly agreements?: AgreementStore) {}

  async append(event: ContractEventRecord): Promise<void> {
    this.events.set(event.eventId, event);
    const list = this.byContract.get(event.contractId) ?? [];
    list.push(event.eventId);
    this.byContract.set(event.contractId, list);
  }

  async listByContract(contractId: string): Promise<ContractEventRecord[]> {
    const ids = this.byContract.get(contractId) ?? [];
    return ids.map((id) => this.events.get(id)!);
  }

  async latestEventId(contractId: string): Promise<string | null> {
    const ids = this.byContract.get(contractId) ?? [];
    return ids[ids.length - 1] ?? null;
  }

  async listByTenant(
    tenantId: string,
    opts: { limit: number; cursor?: string; resource?: string; type?: string },
  ): Promise<{ events: ContractEventRecord[]; cursor?: string }> {
    // Collect all events for this tenant, sorted by createdAt ASC then eventId ASC.
    let records = [...this.events.values()]
      .filter((e) => e.tenantId === tenantId)
      .sort((a, b) => a.createdAt - b.createdAt || a.eventId.localeCompare(b.eventId));

    // Apply type filter.
    if (opts.type) {
      records = records.filter((e) => e.type === opts.type);
    }

    // Apply resource filter — requires agreement lookup.
    if (opts.resource && this.agreements) {
      const resourceCache = new Map<string, string | null>();
      const getResource = async (contractId: string): Promise<string | null> => {
        if (resourceCache.has(contractId)) return resourceCache.get(contractId)!;
        const agreement = await this.agreements!.findById(contractId);
        const r = agreement?.resource ?? null;
        resourceCache.set(contractId, r);
        return r;
      };
      const filtered: ContractEventRecord[] = [];
      for (const e of records) {
        const r = await getResource(e.contractId);
        if (r === opts.resource || r === "*") filtered.push(e);
      }
      records = filtered;
    }

    // Cursor-based pagination: cursor = last eventId seen.
    if (opts.cursor) {
      const cursorIdx = records.findIndex((e) => e.eventId === opts.cursor);
      if (cursorIdx !== -1) records = records.slice(cursorIdx + 1);
    }

    const page = records.slice(0, opts.limit);
    const nextCursor = records.length > opts.limit ? page[page.length - 1]?.eventId : undefined;
    return { events: page, ...(nextCursor ? { cursor: nextCursor } : {}) };
  }
}

// ── Webhook delivery store ─────────────────────────────────────────────────────

export interface WebhookDeliveryStore {
  record(delivery: WebhookDelivery): Promise<void>;
  markSuccess(deliveryId: string, statusCode: number): Promise<void>;
  markFailure(deliveryId: string, error: string, attemptCount: number): Promise<void>;
  listByWebhook(webhookId: string, limit?: number): Promise<WebhookDelivery[]>;
}

export class InMemoryWebhookDeliveryStore implements WebhookDeliveryStore {
  private readonly deliveries = new Map<string, WebhookDelivery>();     // deliveryId → delivery
  private readonly byWebhook = new Map<string, string[]>();             // webhookId → deliveryIds (insertion order)
  private static readonly MAX_PER_WEBHOOK = 200;

  async record(delivery: WebhookDelivery): Promise<void> {
    this.deliveries.set(delivery.deliveryId, delivery);
    const list = this.byWebhook.get(delivery.webhookId) ?? [];
    list.unshift(delivery.deliveryId); // newest first
    // Trim to max per webhook
    if (list.length > InMemoryWebhookDeliveryStore.MAX_PER_WEBHOOK) {
      const removed = list.splice(InMemoryWebhookDeliveryStore.MAX_PER_WEBHOOK);
      for (const id of removed) this.deliveries.delete(id);
    }
    this.byWebhook.set(delivery.webhookId, list);
  }

  async markSuccess(deliveryId: string, statusCode: number): Promise<void> {
    const d = this.deliveries.get(deliveryId);
    if (d) {
      this.deliveries.set(deliveryId, { ...d, statusCode, succeededAt: Math.floor(Date.now() / 1000) });
    }
  }

  async markFailure(deliveryId: string, error: string, attemptCount: number): Promise<void> {
    const d = this.deliveries.get(deliveryId);
    if (d) {
      this.deliveries.set(deliveryId, { ...d, error, attemptCount });
    }
  }

  async listByWebhook(webhookId: string, limit = 50): Promise<WebhookDelivery[]> {
    const ids = this.byWebhook.get(webhookId) ?? [];
    return ids.slice(0, limit).map((id) => this.deliveries.get(id)!);
  }
}
