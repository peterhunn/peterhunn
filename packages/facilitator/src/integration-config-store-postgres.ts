import type postgres from "postgres";
import type { IntegrationConfig, IntegrationConfigStore, IntegrationSource } from "./integration-config-store.js";

type Sql = ReturnType<typeof postgres>;

interface IntegrationConfigRow {
  id: string;
  tenant_id: string;
  source: string;
  credentials: Record<string, string>;
  webhook_secret: string;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

function rowToConfig(r: IntegrationConfigRow): IntegrationConfig {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    source: r.source as IntegrationSource,
    credentials: r.credentials,
    webhookSecret: r.webhook_secret,
    enabled: r.enabled,
    createdAt: Math.floor(r.created_at.getTime() / 1000),
    updatedAt: Math.floor(r.updated_at.getTime() / 1000),
  };
}

export class PostgresIntegrationConfigStore implements IntegrationConfigStore {
  constructor(private readonly sql: Sql) {}

  async upsert(input: {
    tenantId: string;
    source: IntegrationSource;
    credentials: Record<string, string>;
    webhookSecret: string;
  }): Promise<IntegrationConfig> {
    const rows = await this.sql<IntegrationConfigRow[]>`
      INSERT INTO x490_integration_configs (tenant_id, source, credentials, webhook_secret)
      VALUES (
        ${input.tenantId},
        ${input.source},
        ${this.sql.json(input.credentials as import("postgres").JSONValue)},
        ${input.webhookSecret}
      )
      ON CONFLICT (tenant_id, source) DO UPDATE
        SET credentials    = EXCLUDED.credentials,
            webhook_secret = EXCLUDED.webhook_secret,
            enabled        = true,
            updated_at     = now()
      RETURNING *
    `;
    return rowToConfig(rows[0]!);
  }

  async findByTenantAndSource(tenantId: string, source: string): Promise<IntegrationConfig | null> {
    const rows = await this.sql<IntegrationConfigRow[]>`
      SELECT * FROM x490_integration_configs
      WHERE tenant_id = ${tenantId} AND source = ${source}
    `;
    return rows[0] ? rowToConfig(rows[0]) : null;
  }

  async listByTenant(tenantId: string): Promise<IntegrationConfig[]> {
    const rows = await this.sql<IntegrationConfigRow[]>`
      SELECT * FROM x490_integration_configs
      WHERE tenant_id = ${tenantId}
      ORDER BY source ASC
    `;
    return rows.map(rowToConfig);
  }

  async remove(tenantId: string, source: string): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM x490_integration_configs
      WHERE tenant_id = ${tenantId} AND source = ${source}
    `;
    return result.count > 0;
  }
}
