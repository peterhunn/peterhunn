/**
 * External integration store — maps platform workflow IDs to x490 template hashes.
 *
 * Enables the facilitator to:
 *   - Look up which Ironclad workflow a template came from (template → external)
 *   - Look up which x490 template to use when an Ironclad webhook arrives (external → template)
 */

export interface IntegrationMapping {
  id: string;
  /** Platform identifier: "ironclad", "docusign", etc. */
  source: "ironclad";
  /** Platform-native workflow / envelope / document ID. */
  externalId: string;
  tenantId: string;
  templateHash: string;
  createdAt: number;
}

export interface IntegrationStore {
  save(mapping: Omit<IntegrationMapping, "id" | "createdAt">): Promise<IntegrationMapping>;
  findByExternal(source: string, externalId: string): Promise<IntegrationMapping | null>;
  findByTemplate(templateHash: string): Promise<IntegrationMapping | null>;
}

export class InMemoryIntegrationStore implements IntegrationStore {
  private readonly mappings = new Map<string, IntegrationMapping>();
  private readonly byExternal = new Map<string, string>();
  private readonly byTemplate = new Map<string, string>();

  async save(mapping: Omit<IntegrationMapping, "id" | "createdAt">): Promise<IntegrationMapping> {
    const m: IntegrationMapping = {
      ...mapping,
      id: crypto.randomUUID(),
      createdAt: Math.floor(Date.now() / 1000),
    };
    this.mappings.set(m.id, m);
    this.byExternal.set(`${m.source}:${m.externalId}`, m.id);
    this.byTemplate.set(m.templateHash, m.id);
    return m;
  }

  async findByExternal(source: string, externalId: string): Promise<IntegrationMapping | null> {
    const id = this.byExternal.get(`${source}:${externalId}`);
    return id !== undefined ? (this.mappings.get(id) ?? null) : null;
  }

  async findByTemplate(templateHash: string): Promise<IntegrationMapping | null> {
    const id = this.byTemplate.get(templateHash);
    return id !== undefined ? (this.mappings.get(id) ?? null) : null;
  }
}
