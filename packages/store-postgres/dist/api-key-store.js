import { generateApiKey, hashApiKey } from "@legal-agents/api";
function rowToKey(r) {
    return {
        id: r.id,
        orgId: r.org_id,
        name: r.name,
        keyHash: r.key_hash,
        mode: r.mode,
        ...(r.party_id !== null ? { partyId: r.party_id } : {}),
        createdAt: r.created_at,
        ...(r.revoked_at !== null ? { revokedAt: r.revoked_at } : {}),
    };
}
export class PostgresApiKeyStore {
    sql;
    constructor(sql) {
        this.sql = sql;
    }
    async create(orgId, name, mode, partyId) {
        const { raw, hash } = await generateApiKey(mode);
        const rows = await this.sql `
      INSERT INTO api_keys (org_id, name, key_hash, mode, party_id)
      VALUES (${orgId}, ${name}, ${hash}, ${mode}, ${partyId ?? null})
      RETURNING *
    `;
        return { key: rowToKey(rows[0]), raw };
    }
    async findByRawKey(raw) {
        const hash = await hashApiKey(raw);
        const rows = await this.sql `
      SELECT * FROM api_keys
      WHERE key_hash = ${hash} AND revoked_at IS NULL
    `;
        return rows[0] ? rowToKey(rows[0]) : undefined;
    }
    async list(orgId) {
        const rows = await this.sql `
      SELECT * FROM api_keys
      WHERE org_id = ${orgId} AND revoked_at IS NULL
      ORDER BY created_at DESC
    `;
        return rows.map(rowToKey);
    }
    async revoke(id) {
        await this.sql `
      UPDATE api_keys SET revoked_at = now() WHERE id = ${id}
    `;
    }
}
//# sourceMappingURL=api-key-store.js.map