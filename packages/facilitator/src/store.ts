import type { Tenant, RegisteredTemplate, AgreementRecord } from "./types.js";

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
  create(name: string): Promise<{ tenant: Tenant; rawApiKey: string }>;
  findByApiKey(raw: string): Promise<Tenant | null>;
  findById(tenantId: string): Promise<Tenant | null>;
}

export interface TemplateStore {
  register(tenantId: string, content: string, meta: RegisteredTemplate["meta"]): Promise<RegisteredTemplate>;
  findByHash(hash: string): Promise<RegisteredTemplate | null>;
}

export interface AgreementStore {
  record(agreement: AgreementRecord): Promise<void>;
  findById(contractId: string): Promise<AgreementRecord | null>;
  listByTenant(tenantId: string): Promise<AgreementRecord[]>;
  revoke(contractId: string, reason?: string): Promise<boolean>;
  isRevoked(contractId: string): Promise<boolean>;
}

// ── In-memory implementations ──────────────────────────────────────────────────

export class InMemoryTenantStore implements TenantStore {
  private readonly tenants = new Map<string, Tenant>();

  async create(name: string): Promise<{ tenant: Tenant; rawApiKey: string }> {
    const { raw, hash } = await generateApiKey();
    const tenant: Tenant = {
      tenantId: crypto.randomUUID(),
      apiKeyHash: hash,
      hmacSecret: generateHmacSecret(),
      name,
      createdAt: Math.floor(Date.now() / 1000),
    };
    this.tenants.set(tenant.tenantId, tenant);
    return { tenant, rawApiKey: raw };
  }

  async findByApiKey(raw: string): Promise<Tenant | null> {
    const hash = await sha256hex(raw);
    for (const tenant of this.tenants.values()) {
      if (tenant.apiKeyHash === hash) return tenant;
    }
    return null;
  }

  async findById(tenantId: string): Promise<Tenant | null> {
    return this.tenants.get(tenantId) ?? null;
  }
}

export class InMemoryTemplateStore implements TemplateStore {
  private readonly templates = new Map<string, RegisteredTemplate>();

  async register(
    tenantId: string,
    content: string,
    meta: RegisteredTemplate["meta"],
  ): Promise<RegisteredTemplate> {
    const hash = await sha256hex(content);
    const existing = this.templates.get(hash);
    if (existing) return existing;

    const tmpl: RegisteredTemplate = {
      hash,
      tenantId,
      content,
      meta,
      createdAt: Math.floor(Date.now() / 1000),
    };
    this.templates.set(hash, tmpl);
    return tmpl;
  }

  async findByHash(hash: string): Promise<RegisteredTemplate | null> {
    return this.templates.get(hash) ?? null;
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

  async listByTenant(tenantId: string): Promise<AgreementRecord[]> {
    return [...this.agreements.values()].filter((a) => a.tenantId === tenantId);
  }

  async revoke(contractId: string, reason?: string): Promise<boolean> {
    const record = this.agreements.get(contractId);
    if (!record) return false;
    this.agreements.set(contractId, {
      ...record,
      revokedAt: Math.floor(Date.now() / 1000),
      ...(reason !== undefined ? { revokedReason: reason } : {}),
    });
    return true;
  }

  async isRevoked(contractId: string): Promise<boolean> {
    const record = this.agreements.get(contractId);
    return record?.revokedAt !== undefined;
  }
}
