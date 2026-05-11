/** sha256 hex of the raw key string — used for safe storage and lookup. */
export async function hashApiKey(raw) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
    return [...new Uint8Array(buf)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}
/**
 * Generate a new raw API key and its hash.
 * Format: sk_live_<64 hex chars>  /  sk_test_<64 hex chars>
 * The raw value is shown to the user exactly once; only the hash is stored.
 */
export async function generateApiKey(mode) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    const raw = `sk_${mode}_${hex}`;
    return { raw, hash: await hashApiKey(raw) };
}
export class InMemoryApiKeyStore {
    keys = new Map();
    async create(orgId, name, mode, partyId) {
        const { raw, hash } = await generateApiKey(mode);
        const key = {
            id: crypto.randomUUID(),
            orgId,
            name,
            keyHash: hash,
            mode,
            // exactOptionalPropertyTypes: only spread partyId when it has a value
            ...(partyId !== undefined ? { partyId } : {}),
            createdAt: new Date(),
        };
        this.keys.set(key.id, key);
        return { key, raw };
    }
    async findByRawKey(raw) {
        const hash = await hashApiKey(raw);
        return [...this.keys.values()].find((k) => k.keyHash === hash && !k.revokedAt);
    }
    async list(orgId) {
        return [...this.keys.values()].filter((k) => k.orgId === orgId && !k.revokedAt);
    }
    async revoke(id) {
        const key = this.keys.get(id);
        if (key)
            this.keys.set(id, { ...key, revokedAt: new Date() });
    }
}
//# sourceMappingURL=auth.js.map