import type postgres from "postgres";
import type { ApiKeyStore, ApiKey } from "@x490/api";
import { generateApiKey, hashApiKey } from "@x490/api";

type Sql = ReturnType<typeof postgres>;

interface ApiKeyRow {
  id: string;
  org_id: string;
  name: string;
  key_hash: string;
  mode: string;
  party_id: string | null;
  created_at: Date;
  revoked_at: Date | null;
}

function rowToKey(r: ApiKeyRow): ApiKey {
  return {
    id: r.id,
    orgId: r.org_id,
    name: r.name,
    keyHash: r.key_hash,
    mode: r.mode as ApiKey["mode"],
    ...(r.party_id !== null ? { partyId: r.party_id } : {}),
    createdAt: r.created_at,
    ...(r.revoked_at !== null ? { revokedAt: r.revoked_at } : {}),
  };
}

export class PostgresApiKeyStore implements ApiKeyStore {
  constructor(private readonly sql: Sql) {}

  async create(
    orgId: string,
    name: string,
    mode: "live" | "test",
    partyId?: string,
  ): Promise<{ key: ApiKey; raw: string }> {
    const { raw, hash } = await generateApiKey(mode);
    const rows = await this.sql<ApiKeyRow[]>`
      INSERT INTO api_keys (org_id, name, key_hash, mode, party_id)
      VALUES (${orgId}, ${name}, ${hash}, ${mode}, ${partyId ?? null})
      RETURNING *
    `;
    return { key: rowToKey(rows[0]!), raw };
  }

  async findByRawKey(raw: string): Promise<ApiKey | undefined> {
    const hash = await hashApiKey(raw);
    const rows = await this.sql<ApiKeyRow[]>`
      SELECT * FROM api_keys
      WHERE key_hash = ${hash} AND revoked_at IS NULL
    `;
    return rows[0] ? rowToKey(rows[0]) : undefined;
  }

  async list(orgId: string): Promise<ApiKey[]> {
    const rows = await this.sql<ApiKeyRow[]>`
      SELECT * FROM api_keys
      WHERE org_id = ${orgId} AND revoked_at IS NULL
      ORDER BY created_at DESC
    `;
    return rows.map(rowToKey);
  }

  async revoke(id: string): Promise<void> {
    await this.sql`
      UPDATE api_keys SET revoked_at = now() WHERE id = ${id}
    `;
  }
}
