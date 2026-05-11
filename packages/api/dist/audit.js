/**
 * Merkle DAG audit log.
 *
 * Each entry contains:
 *   hash         = sha256( canonicalize({ id, orgId, keyId, contractId, action,
 *                                         payload, parentHashes, createdAt }) )
 *   parentHashes = hashes of all current tips at the time of recording
 *
 * Properties:
 *   Tamper-evidence  — modifying any field changes its hash, breaking every
 *                      descendant's parentHashes reference.
 *   Deletion-evidence — a missing parent hash surfaces as a DAG gap during
 *                      verify(), proving an entry was removed.
 *   Concurrent writes — two simultaneous entries both reference the same tips
 *                      and become new co-tips (proper DAG, not just a chain).
 *   External verification — computeEntryHash() and verifyEntries() are exported
 *                      so auditors can verify logs without trusting the server.
 */
// ── Canonical hash ────────────────────────────────────────────────────────────
/**
 * RFC 8785-style canonical JSON: objects sorted by key, no whitespace.
 * Used so the hash is reproducible by any external tool.
 */
function canonicalize(val) {
    if (val === null || typeof val !== "object")
        return JSON.stringify(val);
    if (Array.isArray(val))
        return `[${val.map(canonicalize).join(",")}]`;
    const keys = Object.keys(val).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(val[k])}`).join(",")}}`;
}
export async function computeEntryHash(entry) {
    const canonical = canonicalize({
        id: entry.id,
        orgId: entry.orgId,
        keyId: entry.keyId,
        contractId: entry.contractId ?? null,
        action: entry.action,
        payload: entry.payload,
        parentHashes: [...entry.parentHashes].sort(),
        createdAt: entry.createdAt.toISOString(),
    });
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    return [...new Uint8Array(buf)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}
// ── DAG verification ──────────────────────────────────────────────────────────
export async function verifyEntries(entries) {
    const byHash = new Map(entries.map((e) => [e.hash, e]));
    const errors = [];
    for (const entry of entries) {
        // Recompute hash and compare
        const { hash, ...rest } = entry;
        const expected = await computeEntryHash(rest);
        if (expected !== hash) {
            errors.push(`Entry ${entry.id} (${entry.action}): hash mismatch — content has been tampered`);
        }
        // Verify every parent exists in this scope
        for (const parentHash of entry.parentHashes) {
            if (!byHash.has(parentHash)) {
                errors.push(`Entry ${entry.id} (${entry.action}): parent ${parentHash.slice(0, 12)}… not found — an entry may have been deleted`);
            }
        }
    }
    const referencedAsParent = new Set(entries.flatMap((e) => e.parentHashes));
    const tips = entries
        .filter((e) => !referencedAsParent.has(e.hash))
        .map((e) => e.hash);
    const roots = entries
        .filter((e) => e.parentHashes.length === 0)
        .map((e) => e.hash);
    return {
        valid: errors.length === 0,
        entryCount: entries.length,
        tips,
        roots,
        errors,
    };
}
// ── In-memory implementation ──────────────────────────────────────────────────
export class MerkleAuditLog {
    /** All entries keyed by hash for O(1) lookup during verify. */
    byHash = new Map();
    /**
     * Current tip hashes per scope key (orgId:contractId).
     * Tips are entries with no known children — the frontier of the DAG.
     * A new entry consumes all current tips as its parents and becomes the new tip.
     */
    tips = new Map();
    scope(orgId, contractId) {
        return `${orgId}:${contractId ?? ""}`;
    }
    async record(partial) {
        const scope = this.scope(partial.orgId, partial.contractId);
        const parentHashes = [...(this.tips.get(scope) ?? new Set())];
        const base = {
            ...partial,
            id: crypto.randomUUID(),
            createdAt: new Date(),
            parentHashes,
        };
        const hash = await computeEntryHash(base);
        const entry = { ...base, hash };
        this.byHash.set(hash, entry);
        this.tips.set(scope, new Set([hash]));
        return entry;
    }
    async query(orgId, contractId, limit = 100) {
        return [...this.byHash.values()]
            .filter((e) => e.orgId === orgId &&
            (contractId === undefined || e.contractId === contractId))
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(0, limit);
    }
    async verify(orgId, contractId) {
        const entries = [...this.byHash.values()].filter((e) => e.orgId === orgId &&
            (contractId === undefined || e.contractId === contractId));
        return verifyEntries(entries);
    }
}
/** @deprecated Use MerkleAuditLog */
export { MerkleAuditLog as InMemoryAuditLog };
//# sourceMappingURL=audit.js.map