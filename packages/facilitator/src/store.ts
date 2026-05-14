import type { Tenant, TenantApiKey, RegisteredTemplate, AgreementRecord, RequirementsConfig, Webhook, WebhookEventType } from "./types.js";

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
}

export interface TemplateStore {
  register(
    tenantId: string,
    content: string,
    meta: RegisteredTemplate["meta"],
    terms?: RegisteredTemplate["terms"],
  ): Promise<RegisteredTemplate>;
  findByHash(hash: string): Promise<RegisteredTemplate | null>;
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
  listByTenant(tenantId: string, opts?: { resource?: string; limit?: number; after?: string }): Promise<{
    agreements: AgreementRecord[];
    nextCursor: string | null;
  }>;
  revoke(contractId: string, reason?: string): Promise<boolean>;
  isRevoked(contractId: string): Promise<boolean>;
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
}

export class InMemoryTemplateStore implements TemplateStore {
  private readonly templates = new Map<string, RegisteredTemplate>();

  async register(
    tenantId: string,
    content: string,
    meta: RegisteredTemplate["meta"],
    terms?: RegisteredTemplate["terms"],
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
      createdAt: Math.floor(Date.now() / 1000),
    };
    this.templates.set(hash, tmpl);
    return tmpl;
  }

  async findByHash(hash: string): Promise<RegisteredTemplate | null> {
    return this.templates.get(hash) ?? null;
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

  async record(agreement: AgreementRecord): Promise<void> {
    this.agreements.set(agreement.contractId, agreement);
  }

  async findById(contractId: string): Promise<AgreementRecord | null> {
    return this.agreements.get(contractId) ?? null;
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
