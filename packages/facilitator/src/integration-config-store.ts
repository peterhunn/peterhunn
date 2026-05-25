/**
 * Per-tenant integration credential store.
 *
 * Stores the API keys, access tokens, and webhook secrets that operators
 * configure via the dashboard or admin API. In production, credentials should
 * be encrypted at rest (use KMS or a secrets manager).
 */

export type IntegrationSource = "ironclad" | "docusign";

/**
 * Credentials for a specific integration source.
 *
 * Ironclad fields:  apiKey, baseUrl (optional)
 * DocuSign fields:  accessToken, accountId, baseUrl (optional)
 */
export interface IntegrationConfig {
  id: string;
  tenantId: string;
  source: IntegrationSource;
  /** Source-specific credentials — treat as opaque key-value pairs. */
  credentials: Record<string, string>;
  /** HMAC secret for verifying incoming webhooks from this source. */
  webhookSecret: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface IntegrationConfigStore {
  upsert(config: {
    tenantId: string;
    source: IntegrationSource;
    credentials: Record<string, string>;
    webhookSecret: string;
  }): Promise<IntegrationConfig>;
  findByTenantAndSource(tenantId: string, source: string): Promise<IntegrationConfig | null>;
  listByTenant(tenantId: string): Promise<IntegrationConfig[]>;
  remove(tenantId: string, source: string): Promise<boolean>;
}

export class InMemoryIntegrationConfigStore implements IntegrationConfigStore {
  // key: `${tenantId}:${source}`
  private readonly configs = new Map<string, IntegrationConfig>();

  async upsert(input: {
    tenantId: string;
    source: IntegrationSource;
    credentials: Record<string, string>;
    webhookSecret: string;
  }): Promise<IntegrationConfig> {
    const key = `${input.tenantId}:${input.source}`;
    const existing = this.configs.get(key);
    const now = Math.floor(Date.now() / 1000);
    const config: IntegrationConfig = {
      id: existing?.id ?? crypto.randomUUID(),
      tenantId: input.tenantId,
      source: input.source,
      credentials: input.credentials,
      webhookSecret: input.webhookSecret,
      enabled: true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.configs.set(key, config);
    return config;
  }

  async findByTenantAndSource(tenantId: string, source: string): Promise<IntegrationConfig | null> {
    return this.configs.get(`${tenantId}:${source}`) ?? null;
  }

  async listByTenant(tenantId: string): Promise<IntegrationConfig[]> {
    return [...this.configs.values()].filter((c) => c.tenantId === tenantId);
  }

  async remove(tenantId: string, source: string): Promise<boolean> {
    return this.configs.delete(`${tenantId}:${source}`);
  }
}
