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
import type { Tenant, TenantApiKey, RegisteredTemplate, AgreementRecord, RequirementsConfig, Webhook, WebhookEventType, ContractEventRecord, PendingContract, WebhookDelivery } from "./types.js";
import type { TenantStore, TemplateStore, AgreementStore, RequirementsStore, WebhookStore, EventStore, PendingContractStore, WebhookDeliveryStore } from "./store.js";
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

  async findOrCreateByAuth0Sub(sub: string): Promise<import("./types.js").Tenant> {
    const rows = await this.sql<TenantRow[]>`
      INSERT INTO x490_tenants (name, hmac_secret, auth0_sub)
      VALUES (${sub}, ${generateHmacSecret()}, ${sub})
      ON CONFLICT (auth0_sub) DO UPDATE SET auth0_sub = EXCLUDED.auth0_sub
      RETURNING *
    `;
    return rowToTenant(rows[0]!);
  }

  async delete(tenantId: string): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM x490_tenants WHERE tenant_id = ${tenantId}
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
  terms: import("@x490/core").ContractTerms | null;
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
    ...(r.terms ? { terms: r.terms } : {}),
    createdAt: Math.floor(r.created_at.getTime() / 1000),
  };
}

export class PostgresTemplateStore implements TemplateStore {
  constructor(private readonly sql: Sql) {}

  async register(
    tenantId: string,
    content: string,
    meta: RegisteredTemplate["meta"],
    terms?: RegisteredTemplate["terms"],
  ): Promise<RegisteredTemplate> {
    const hash = await sha256hex(content);
    const rows = await this.sql<TemplateRow[]>`
      INSERT INTO x490_templates (hash, tenant_id, content, title, description, terms)
      VALUES (
        ${hash}, ${tenantId}, ${content},
        ${meta.title ?? null}, ${meta.description ?? null},
        ${terms ? this.sql.json(JSON.parse(JSON.stringify(terms)) as import("postgres").JSONValue) : null}
      )
      ON CONFLICT (hash) DO UPDATE
        SET title       = COALESCE(EXCLUDED.title, x490_templates.title),
            description = COALESCE(EXCLUDED.description, x490_templates.description),
            terms       = COALESCE(EXCLUDED.terms, x490_templates.terms)
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

  async listByTenant(
    tenantId: string,
    opts: { limit?: number; after?: string } = {},
  ): Promise<{ templates: RegisteredTemplate[]; nextCursor: string | null }> {
    const limit = Math.min(opts.limit ?? 50, 200);

    let rows: TemplateRow[];
    if (opts.after) {
      const [afterTs, afterHash] = decodeCursor(opts.after);
      const afterDate = new Date(afterTs * 1000);
      rows = await this.sql<TemplateRow[]>`
        SELECT * FROM x490_templates
        WHERE tenant_id = ${tenantId}
          AND (created_at < ${afterDate} OR (created_at = ${afterDate} AND hash > ${afterHash}))
        ORDER BY created_at DESC, hash ASC
        LIMIT ${limit}
      `;
    } else {
      rows = await this.sql<TemplateRow[]>`
        SELECT * FROM x490_templates
        WHERE tenant_id = ${tenantId}
        ORDER BY created_at DESC, hash ASC
        LIMIT ${limit}
      `;
    }

    const templates = rows.map(rowToTemplate);
    const last = templates[templates.length - 1];
    const nextCursor = templates.length === limit && last
      ? encodeCursor(last.createdAt, last.hash)
      : null;
    return { templates, nextCursor };
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
  negotiable: boolean;
  negotiable_fields: import("@x490/protocol").NegotiableField[] | null;
  required_parties: number;
  created_at: Date;
}

function rowToRequirements(r: RequirementsRow): RequirementsConfig {
  const nf = r.negotiable_fields;
  return {
    id: r.id,
    tenantId: r.tenant_id,
    templateHash: r.template_hash,
    resource: r.resource,
    expiresIn: r.expires_in,
    requiredPartyFields: r.required_party_fields,
    negotiable: r.negotiable,
    ...(nf && nf.length > 0 ? { negotiableFields: nf } : {}),
    ...(r.required_parties > 1 ? { requiredParties: r.required_parties } : {}),
    createdAt: Math.floor(r.created_at.getTime() / 1000),
  };
}

export class PostgresRequirementsStore implements RequirementsStore {
  constructor(private readonly sql: Sql) {}

  async upsert(config: Omit<RequirementsConfig, "id" | "createdAt">): Promise<RequirementsConfig> {
    const nfJson = config.negotiableFields
      ? this.sql.json(JSON.parse(JSON.stringify(config.negotiableFields)) as import("postgres").JSONValue)
      : this.sql.json([] as import("postgres").JSONValue);
    const requiredParties = config.requiredParties ?? 1;
    const rows = await this.sql<RequirementsRow[]>`
      INSERT INTO x490_requirements (tenant_id, template_hash, resource, expires_in, required_party_fields, negotiable, negotiable_fields, required_parties)
      VALUES (
        ${config.tenantId},
        ${config.templateHash},
        ${config.resource},
        ${config.expiresIn},
        ${this.sql.array(config.requiredPartyFields)},
        ${config.negotiable ?? false},
        ${nfJson},
        ${requiredParties}
      )
      ON CONFLICT (tenant_id, template_hash, resource) DO UPDATE
        SET expires_in            = EXCLUDED.expires_in,
            required_party_fields = EXCLUDED.required_party_fields,
            negotiable            = EXCLUDED.negotiable,
            negotiable_fields     = EXCLUDED.negotiable_fields,
            required_parties      = EXCLUDED.required_parties
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

// ── Webhook store ──────────────────────────────────────────────────────────────

interface WebhookRow {
  webhook_id: string;
  tenant_id: string;
  url: string;
  secret: string;
  events: string[];
  active: boolean;
  created_at: Date;
}

function rowToWebhook(r: WebhookRow): Webhook {
  return {
    webhookId: r.webhook_id,
    tenantId: r.tenant_id,
    url: r.url,
    secret: r.secret,
    events: r.events as WebhookEventType[],
    active: r.active,
    createdAt: Math.floor(r.created_at.getTime() / 1000),
  };
}

function generateWebhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class PostgresWebhookStore implements WebhookStore {
  constructor(private readonly sql: Sql) {}

  async create(tenantId: string, url: string, events: WebhookEventType[]): Promise<{ webhook: Webhook; secret: string }> {
    const secret = generateWebhookSecret();
    const rows = await this.sql<WebhookRow[]>`
      INSERT INTO x490_webhooks (tenant_id, url, secret, events)
      VALUES (${tenantId}, ${url}, ${secret}, ${this.sql.array(events)})
      RETURNING *
    `;
    return { webhook: rowToWebhook(rows[0]!), secret };
  }

  async list(tenantId: string): Promise<Webhook[]> {
    const rows = await this.sql<WebhookRow[]>`
      SELECT * FROM x490_webhooks WHERE tenant_id = ${tenantId} ORDER BY created_at DESC
    `;
    return rows.map(rowToWebhook);
  }

  async findById(webhookId: string): Promise<Webhook | null> {
    const rows = await this.sql<WebhookRow[]>`
      SELECT * FROM x490_webhooks WHERE webhook_id = ${webhookId}
    `;
    return rows[0] ? rowToWebhook(rows[0]) : null;
  }

  async disable(webhookId: string): Promise<void> {
    await this.sql`
      UPDATE x490_webhooks SET active = false WHERE webhook_id = ${webhookId}
    `;
  }

  async listActiveForEvent(tenantId: string, event: WebhookEventType): Promise<Webhook[]> {
    const rows = await this.sql<WebhookRow[]>`
      SELECT * FROM x490_webhooks
      WHERE tenant_id = ${tenantId}
        AND active = true
        AND ${event} = ANY(events)
    `;
    return rows.map(rowToWebhook);
  }
}

// ── Event store ────────────────────────────────────────────────────────────────

interface EventRow {
  event_id: string;
  contract_id: string;
  tenant_id: string;
  type: string;
  party: string | null;
  payload: Record<string, unknown>;
  parent_event_ids: string[];
  created_at: Date;
}

function rowToEvent(r: EventRow): ContractEventRecord {
  const e: ContractEventRecord = {
    eventId: r.event_id,
    contractId: r.contract_id,
    tenantId: r.tenant_id,
    type: r.type,
    payload: r.payload,
    parentEventIds: r.parent_event_ids,
    createdAt: Math.floor(r.created_at.getTime() / 1000),
  };
  if (r.party !== null) e.party = r.party;
  return e;
}

export class PostgresEventStore implements EventStore {
  constructor(private readonly sql: Sql) {}

  async append(event: ContractEventRecord): Promise<void> {
    await this.sql`
      INSERT INTO x490_contract_events
        (event_id, contract_id, tenant_id, type, party, payload, parent_event_ids)
      VALUES (
        ${event.eventId}, ${event.contractId}, ${event.tenantId},
        ${event.type}, ${event.party ?? null},
        ${this.sql.json(event.payload as import("postgres").JSONValue)},
        ${event.parentEventIds}
      )
    `;
  }

  async listByContract(contractId: string): Promise<ContractEventRecord[]> {
    const rows = await this.sql<EventRow[]>`
      SELECT * FROM x490_contract_events
      WHERE contract_id = ${contractId}
      ORDER BY created_at ASC
    `;
    return rows.map(rowToEvent);
  }

  async latestEventId(contractId: string): Promise<string | null> {
    const rows = await this.sql<{ event_id: string }[]>`
      SELECT event_id FROM x490_contract_events
      WHERE contract_id = ${contractId}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    return rows[0]?.event_id ?? null;
  }

  async listByTenant(
    tenantId: string,
    opts: { limit: number; cursor?: string; resource?: string; type?: string },
  ): Promise<{ events: ContractEventRecord[]; cursor?: string }> {
    const fetchLimit = opts.limit + 1;
    let rows: EventRow[];

    if (opts.resource && opts.type && opts.cursor) {
      rows = await this.sql<EventRow[]>`
        SELECT e.* FROM x490_contract_events e
        JOIN x490_agreements a ON a.contract_id = e.contract_id
        WHERE e.tenant_id = ${tenantId}
          AND e.type = ${opts.type}
          AND (a.resource = ${opts.resource} OR a.resource = '*')
          AND e.event_id > ${opts.cursor}
        ORDER BY e.created_at ASC, e.event_id ASC
        LIMIT ${fetchLimit}
      `;
    } else if (opts.resource && opts.type) {
      rows = await this.sql<EventRow[]>`
        SELECT e.* FROM x490_contract_events e
        JOIN x490_agreements a ON a.contract_id = e.contract_id
        WHERE e.tenant_id = ${tenantId}
          AND e.type = ${opts.type}
          AND (a.resource = ${opts.resource} OR a.resource = '*')
        ORDER BY e.created_at ASC, e.event_id ASC
        LIMIT ${fetchLimit}
      `;
    } else if (opts.resource && opts.cursor) {
      rows = await this.sql<EventRow[]>`
        SELECT e.* FROM x490_contract_events e
        JOIN x490_agreements a ON a.contract_id = e.contract_id
        WHERE e.tenant_id = ${tenantId}
          AND (a.resource = ${opts.resource} OR a.resource = '*')
          AND e.event_id > ${opts.cursor}
        ORDER BY e.created_at ASC, e.event_id ASC
        LIMIT ${fetchLimit}
      `;
    } else if (opts.resource) {
      rows = await this.sql<EventRow[]>`
        SELECT e.* FROM x490_contract_events e
        JOIN x490_agreements a ON a.contract_id = e.contract_id
        WHERE e.tenant_id = ${tenantId}
          AND (a.resource = ${opts.resource} OR a.resource = '*')
        ORDER BY e.created_at ASC, e.event_id ASC
        LIMIT ${fetchLimit}
      `;
    } else if (opts.type && opts.cursor) {
      rows = await this.sql<EventRow[]>`
        SELECT * FROM x490_contract_events
        WHERE tenant_id = ${tenantId}
          AND type = ${opts.type}
          AND event_id > ${opts.cursor}
        ORDER BY created_at ASC, event_id ASC
        LIMIT ${fetchLimit}
      `;
    } else if (opts.type) {
      rows = await this.sql<EventRow[]>`
        SELECT * FROM x490_contract_events
        WHERE tenant_id = ${tenantId}
          AND type = ${opts.type}
        ORDER BY created_at ASC, event_id ASC
        LIMIT ${fetchLimit}
      `;
    } else if (opts.cursor) {
      rows = await this.sql<EventRow[]>`
        SELECT * FROM x490_contract_events
        WHERE tenant_id = ${tenantId}
          AND event_id > ${opts.cursor}
        ORDER BY created_at ASC, event_id ASC
        LIMIT ${fetchLimit}
      `;
    } else {
      rows = await this.sql<EventRow[]>`
        SELECT * FROM x490_contract_events
        WHERE tenant_id = ${tenantId}
        ORDER BY created_at ASC, event_id ASC
        LIMIT ${fetchLimit}
      `;
    }

    const hasMore = rows.length > opts.limit;
    const page = hasMore ? rows.slice(0, opts.limit) : rows;
    const events = page.map(rowToEvent);
    const cursor = hasMore ? page[page.length - 1]?.event_id : undefined;
    return { events, ...(cursor ? { cursor } : {}) };
  }
}

// ── Pending contract store ─────────────────────────────────────────────────────

interface PendingContractRow {
  contract_id: string;
  tenant_id: string;
  template_hash: string;
  required_parties: number;
  acceptances: unknown;
  completed_at: Date | null;
  created_at: Date;
}

function rowToPendingContract(r: PendingContractRow): PendingContract {
  const entry: PendingContract = {
    contractId: r.contract_id,
    tenantId: r.tenant_id,
    templateHash: r.template_hash,
    requiredParties: r.required_parties,
    acceptances: r.acceptances as PendingContract["acceptances"],
    createdAt: Math.floor(r.created_at.getTime() / 1000),
  };
  if (r.completed_at !== null) entry.completedAt = Math.floor(r.completed_at.getTime() / 1000);
  return entry;
}

export class PostgresPendingContractStore implements PendingContractStore {
  constructor(private readonly sql: Sql) {}

  async create(entry: Omit<PendingContract, "acceptances" | "createdAt">): Promise<PendingContract> {
    const rows = await this.sql<PendingContractRow[]>`
      INSERT INTO x490_pending_contracts (contract_id, tenant_id, template_hash, required_parties)
      VALUES (${entry.contractId}, ${entry.tenantId}, ${entry.templateHash}, ${entry.requiredParties})
      RETURNING *
    `;
    return rowToPendingContract(rows[0]!);
  }

  async addParty(contractId: string, partyId: string, partyData: Record<string, string>): Promise<PendingContract | null> {
    return await this.sql.begin(async (tx) => {
      const rows = await tx<PendingContractRow[]>`
        SELECT * FROM x490_pending_contracts
        WHERE contract_id = ${contractId} AND completed_at IS NULL
        FOR UPDATE
      `;
      if (!rows[0]) return null;
      const acceptance = { partyId, partyData, acceptedAt: Math.floor(Date.now() / 1000) };
      const updated = await tx<PendingContractRow[]>`
        UPDATE x490_pending_contracts
        SET acceptances = acceptances || ${this.sql.json(acceptance as import("postgres").JSONValue)}::jsonb
        WHERE contract_id = ${contractId}
        RETURNING *
      `;
      return rowToPendingContract(updated[0]!);
    });
  }

  async get(contractId: string): Promise<PendingContract | null> {
    const rows = await this.sql<PendingContractRow[]>`
      SELECT * FROM x490_pending_contracts
      WHERE contract_id = ${contractId} AND completed_at IS NULL
    `;
    return rows[0] ? rowToPendingContract(rows[0]) : null;
  }

  async complete(contractId: string): Promise<void> {
    await this.sql`
      UPDATE x490_pending_contracts
      SET completed_at = now()
      WHERE contract_id = ${contractId}
    `;
  }

  async listByTenant(tenantId: string): Promise<PendingContract[]> {
    const rows = await this.sql<PendingContractRow[]>`
      SELECT * FROM x490_pending_contracts
      WHERE tenant_id = ${tenantId} AND completed_at IS NULL
      ORDER BY created_at DESC
    `;
    return rows.map(rowToPendingContract);
  }
}

// ── Webhook delivery store ─────────────────────────────────────────────────────

interface WebhookDeliveryRow {
  delivery_id: string;
  webhook_id: string;
  tenant_id: string;
  event_type: string;
  contract_id: string | null;
  status_code: number | null;
  error: string | null;
  attempt_count: number;
  succeeded_at: Date | null;
  created_at: Date;
}

function rowToWebhookDelivery(r: WebhookDeliveryRow): WebhookDelivery {
  const d: WebhookDelivery = {
    deliveryId: r.delivery_id,
    webhookId: r.webhook_id,
    tenantId: r.tenant_id,
    eventType: r.event_type,
    attemptCount: r.attempt_count,
    createdAt: Math.floor(r.created_at.getTime() / 1000),
  };
  if (r.contract_id !== null) d.contractId = r.contract_id;
  if (r.status_code !== null) d.statusCode = r.status_code;
  if (r.error !== null) d.error = r.error;
  if (r.succeeded_at !== null) d.succeededAt = Math.floor(r.succeeded_at.getTime() / 1000);
  return d;
}

export class PostgresWebhookDeliveryStore implements WebhookDeliveryStore {
  constructor(private readonly sql: Sql) {}

  async record(delivery: WebhookDelivery): Promise<void> {
    await this.sql`
      INSERT INTO x490_webhook_deliveries
        (delivery_id, webhook_id, tenant_id, event_type, contract_id, attempt_count)
      VALUES (
        ${delivery.deliveryId}, ${delivery.webhookId}, ${delivery.tenantId},
        ${delivery.eventType}, ${delivery.contractId ?? null}, ${delivery.attemptCount}
      )
    `;
  }

  async markSuccess(deliveryId: string, statusCode: number): Promise<void> {
    await this.sql`
      UPDATE x490_webhook_deliveries
      SET status_code = ${statusCode}, succeeded_at = now()
      WHERE delivery_id = ${deliveryId}
    `;
  }

  async markFailure(deliveryId: string, error: string, attemptCount: number): Promise<void> {
    await this.sql`
      UPDATE x490_webhook_deliveries
      SET error = ${error}, attempt_count = ${attemptCount}
      WHERE delivery_id = ${deliveryId}
    `;
  }

  async listByWebhook(webhookId: string, limit = 50): Promise<WebhookDelivery[]> {
    const rows = await this.sql<WebhookDeliveryRow[]>`
      SELECT * FROM x490_webhook_deliveries
      WHERE webhook_id = ${webhookId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows.map(rowToWebhookDelivery);
  }
}
