/**
 * Postgres-backed store implementations for the x490 facilitator.
 *
 * Usage:
 *   import postgres from "postgres";
 *   import { PostgresTenantStore, ... } from "./store-postgres.js";
 *
 *   const sql = postgres(process.env.DATABASE_URL);
 *   const tenants = new PostgresTenantStore(sql);
 */

import type postgres from "postgres";
import type { Tenant, TenantApiKey, RegisteredTemplate, AgreementRecord, RequirementsConfig } from "./types.js";
import type { TenantStore, TemplateStore, AgreementStore, RequirementsStore } from "./store.js";
import { sha256hex, encodeCursor, decodeCursor } from "./store.js";

type Sql = ReturnType<typeof postgres>;

// ── Tenant + API key store ─────────────────────────────────────────────────────

interface TenantRow {
  tenant_id: string;
  hmac_secret: string;
  name: string;
  created_at: Date;
}

interface ApiKeyRow {
  key_id: string;
  tenant_id: string;
  key_hash: string;
  name: string;
  created_at: Date;
  revoked_at: Date | null;
}

function rowToTenant(r: TenantRow): Tenant {
  return {
    tenantId: r.tenant_id,
    hmacSecret: r.hmac_secret,
    name: r.name,
    createdAt: Math.floor(r.created_at.getTime() / 1000),
  };
}

function rowToApiKey(r: ApiKeyRow): TenantApiKey {
  const key: TenantApiKey = {
    keyId: r.key_id,
    tenantId: r.tenant_id,
    keyHash: r.key_hash,
    name: r.name,
    createdAt: Math.floor(r.created_at.getTime() / 1000),
  };
  if (r.revoked_at !== null) key.revokedAt = Math.floor(r.revoked_at.getTime() / 1000);
  return key;
}

function generateHmacSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function generateApiKey(): Promise<{ raw: string; hash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const raw = `sk_x490_${hex}`;
  return { raw, hash: await sha256hex(raw) };
}

export class PostgresTenantStore implements TenantStore {
  constructor(private readonly sql: Sql) {}

  async create(name: string): Promise<{ tenant: Tenant; rawApiKey: string; keyId: string }> {
    const { raw, hash } = await generateApiKey();
    const hmacSecret = generateHmacSecret();

    const result = await this.sql.begin(async (tx) => {
      const tenantRows = await tx<TenantRow[]>`
        INSERT INTO x490_tenants (name, hmac_secret)
        VALUES (${name}, ${hmacSecret})
        RETURNING *
      `;
      const tenant = rowToTenant(tenantRows[0]!);

      const keyRows = await tx<ApiKeyRow[]>`
        INSERT INTO x490_api_keys (tenant_id, name, key_hash)
        VALUES (${tenant.tenantId}, 'default', ${hash})
        RETURNING *
      `;
      const key = rowToApiKey(keyRows[0]!);
      return { tenant, key };
    });

    return { tenant: result.tenant, rawApiKey: raw, keyId: result.key.keyId };
  }

  async findById(tenantId: string): Promise<Tenant | null> {
    const rows = await this.sql<TenantRow[]>`
      SELECT * FROM x490_tenants WHERE tenant_id = ${tenantId}
    `;
    return rows[0] ? rowToTenant(rows[0]) : null;
  }

  async findByApiKey(raw: string): Promise<Tenant | null> {
    const hash = await sha256hex(raw);
    const rows = await this.sql<TenantRow[]>`
      SELECT t.*
      FROM x490_tenants t
      JOIN x490_api_keys k ON k.tenant_id = t.tenant_id
      WHERE k.key_hash = ${hash} AND k.revoked_at IS NULL
      LIMIT 1
    `;
    return rows[0] ? rowToTenant(rows[0]) : null;
  }

  async createApiKey(tenantId: string, name: string): Promise<{ keyId: string; rawApiKey: string }> {
    const { raw, hash } = await generateApiKey();
    const rows = await this.sql<ApiKeyRow[]>`
      INSERT INTO x490_api_keys (tenant_id, name, key_hash)
      VALUES (${tenantId}, ${name}, ${hash})
      RETURNING *
    `;
    return { keyId: rows[0]!.key_id, rawApiKey: raw };
  }

  async listApiKeys(tenantId: string): Promise<TenantApiKey[]> {
    const rows = await this.sql<ApiKeyRow[]>`
      SELECT * FROM x490_api_keys
      WHERE tenant_id = ${tenantId}
      ORDER BY created_at DESC
    `;
    return rows.map(rowToApiKey);
  }

  async revokeApiKey(keyId: string): Promise<boolean> {
    const result = await this.sql`
      UPDATE x490_api_keys
      SET revoked_at = now()
      WHERE key_id = ${keyId} AND revoked_at IS NULL
    `;
    return result.count > 0;
  }
}

// ── Template store ─────────────────────────────────────────────────────────────

interface TemplateRow {
  hash: string;
  tenant_id: string;
  content: string;
  title: string | null;
  description: string | null;
  created_at: Date;
}

function rowToTemplate(r: TemplateRow): RegisteredTemplate {
  const meta: RegisteredTemplate["meta"] = {};
  if (r.title !== null) meta.title = r.title;
  if (r.description !== null) meta.description = r.description;
  return {
    hash: r.hash,
    tenantId: r.tenant_id,
    content: r.content,
    meta,
    createdAt: Math.floor(r.created_at.getTime() / 1000),
  };
}

export class PostgresTemplateStore implements TemplateStore {
  constructor(private readonly sql: Sql) {}

  async register(
    tenantId: string,
    content: string,
    meta: RegisteredTemplate["meta"],
  ): Promise<RegisteredTemplate> {
    const hash = await sha256hex(content);
    const rows = await this.sql<TemplateRow[]>`
      INSERT INTO x490_templates (hash, tenant_id, content, title, description)
      VALUES (${hash}, ${tenantId}, ${content}, ${meta.title ?? null}, ${meta.description ?? null})
      ON CONFLICT (hash) DO UPDATE
        SET title = COALESCE(EXCLUDED.title, x490_templates.title),
            description = COALESCE(EXCLUDED.description, x490_templates.description)
      RETURNING *
    `;
    return rowToTemplate(rows[0]!);
  }

  async findByHash(hash: string): Promise<RegisteredTemplate | null> {
    const rows = await this.sql<TemplateRow[]>`
      SELECT * FROM x490_templates WHERE hash = ${hash}
    `;
    return rows[0] ? rowToTemplate(rows[0]) : null;
  }
}

// ── Requirements store ─────────────────────────────────────────────────────────

interface RequirementsRow {
  id: string;
  tenant_id: string;
  template_hash: string;
  resource: string;
  expires_in: number;
  required_party_fields: string[];
  created_at: Date;
}

function rowToRequirements(r: RequirementsRow): RequirementsConfig {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    templateHash: r.template_hash,
    resource: r.resource,
    expiresIn: r.expires_in,
    requiredPartyFields: r.required_party_fields,
    createdAt: Math.floor(r.created_at.getTime() / 1000),
  };
}

export class PostgresRequirementsStore implements RequirementsStore {
  constructor(private readonly sql: Sql) {}

  async upsert(config: Omit<RequirementsConfig, "id" | "createdAt">): Promise<RequirementsConfig> {
    const rows = await this.sql<RequirementsRow[]>`
      INSERT INTO x490_requirements (tenant_id, template_hash, resource, expires_in, required_party_fields)
      VALUES (
        ${config.tenantId},
        ${config.templateHash},
        ${config.resource},
        ${config.expiresIn},
        ${this.sql.array(config.requiredPartyFields)}
      )
      ON CONFLICT (tenant_id, template_hash, resource) DO UPDATE
        SET expires_in           = EXCLUDED.expires_in,
            required_party_fields = EXCLUDED.required_party_fields
      RETURNING *
    `;
    return rowToRequirements(rows[0]!);
  }

  async findByTemplate(tenantId: string, templateHash: string): Promise<RequirementsConfig | null> {
    const rows = await this.sql<RequirementsRow[]>`
      SELECT * FROM x490_requirements
      WHERE tenant_id = ${tenantId} AND template_hash = ${templateHash}
      ORDER BY expires_in DESC
      LIMIT 1
    `;
    return rows[0] ? rowToRequirements(rows[0]) : null;
  }

  async findByResource(tenantId: string, templateHash: string, resource: string): Promise<RequirementsConfig | null> {
    const rows = await this.sql<RequirementsRow[]>`
      SELECT * FROM x490_requirements
      WHERE tenant_id = ${tenantId}
        AND template_hash = ${templateHash}
        AND resource = ${resource}
      LIMIT 1
    `;
    return rows[0] ? rowToRequirements(rows[0]) : null;
  }
}

// ── Agreement store ────────────────────────────────────────────────────────────

interface AgreementRow {
  contract_id: string;
  tenant_id: string;
  template_hash: string;
  party_id: string;
  resource: string;
  party_data: unknown;
  token: string;
  issued_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_reason: string | null;
}

function rowToAgreement(r: AgreementRow): AgreementRecord {
  const record: AgreementRecord = {
    contractId: r.contract_id,
    tenantId: r.tenant_id,
    templateHash: r.template_hash,
    partyId: r.party_id,
    resource: r.resource,
    partyData: r.party_data as Record<string, string>,
    token: r.token,
    issuedAt: Math.floor(r.issued_at.getTime() / 1000),
    expiresAt: Math.floor(r.expires_at.getTime() / 1000),
  };
  if (r.revoked_at !== null) record.revokedAt = Math.floor(r.revoked_at.getTime() / 1000);
  if (r.revoked_reason !== null) record.revokedReason = r.revoked_reason;
  return record;
}

export class PostgresAgreementStore implements AgreementStore {
  constructor(private readonly sql: Sql) {}

  async record(a: AgreementRecord): Promise<void> {
    await this.sql`
      INSERT INTO x490_agreements (
        contract_id, tenant_id, template_hash, party_id, resource,
        party_data, token, issued_at, expires_at
      ) VALUES (
        ${a.contractId}, ${a.tenantId}, ${a.templateHash}, ${a.partyId}, ${a.resource},
        ${this.sql.json(a.partyData as never)}, ${a.token},
        to_timestamp(${a.issuedAt}), to_timestamp(${a.expiresAt})
      )
      ON CONFLICT (contract_id) DO NOTHING
    `;
  }

  async findById(contractId: string): Promise<AgreementRecord | null> {
    const rows = await this.sql<AgreementRow[]>`
      SELECT * FROM x490_agreements WHERE contract_id = ${contractId}
    `;
    return rows[0] ? rowToAgreement(rows[0]) : null;
  }

  async listByTenant(
    tenantId: string,
    opts: { resource?: string; limit?: number; after?: string } = {},
  ): Promise<{ agreements: AgreementRecord[]; nextCursor: string | null }> {
    const limit = Math.min(opts.limit ?? 50, 200);

    let rows: AgreementRow[];
    if (opts.after) {
      const [afterTs, afterId] = decodeCursor(opts.after);
      const afterDate = new Date(afterTs * 1000);
      if (opts.resource) {
        rows = await this.sql<AgreementRow[]>`
          SELECT * FROM x490_agreements
          WHERE tenant_id = ${tenantId}
            AND (resource = ${opts.resource} OR resource = '*')
            AND (issued_at < ${afterDate} OR (issued_at = ${afterDate} AND contract_id > ${afterId}))
          ORDER BY issued_at DESC, contract_id ASC
          LIMIT ${limit}
        `;
      } else {
        rows = await this.sql<AgreementRow[]>`
          SELECT * FROM x490_agreements
          WHERE tenant_id = ${tenantId}
            AND (issued_at < ${afterDate} OR (issued_at = ${afterDate} AND contract_id > ${afterId}))
          ORDER BY issued_at DESC, contract_id ASC
          LIMIT ${limit}
        `;
      }
    } else {
      if (opts.resource) {
        rows = await this.sql<AgreementRow[]>`
          SELECT * FROM x490_agreements
          WHERE tenant_id = ${tenantId}
            AND (resource = ${opts.resource} OR resource = '*')
          ORDER BY issued_at DESC, contract_id ASC
          LIMIT ${limit}
        `;
      } else {
        rows = await this.sql<AgreementRow[]>`
          SELECT * FROM x490_agreements
          WHERE tenant_id = ${tenantId}
          ORDER BY issued_at DESC, contract_id ASC
          LIMIT ${limit}
        `;
      }
    }

    const agreements = rows.map(rowToAgreement);
    const last = agreements[agreements.length - 1];
    const nextCursor = agreements.length === limit && last
      ? encodeCursor(last.issuedAt, last.contractId)
      : null;

    return { agreements, nextCursor };
  }

  async revoke(contractId: string, reason?: string): Promise<boolean> {
    const result = await this.sql`
      UPDATE x490_agreements
      SET revoked_at = now(), revoked_reason = ${reason ?? null}
      WHERE contract_id = ${contractId} AND revoked_at IS NULL
    `;
    return result.count > 0;
  }

  async isRevoked(contractId: string): Promise<boolean> {
    const rows = await this.sql<{ revoked_at: Date | null }[]>`
      SELECT revoked_at FROM x490_agreements WHERE contract_id = ${contractId}
    `;
    return rows[0]?.revoked_at !== null && rows[0]?.revoked_at !== undefined;
  }
}
