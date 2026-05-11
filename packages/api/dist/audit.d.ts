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
export interface AuditEntry {
    id: string;
    orgId: string;
    keyId: string;
    contractId?: string;
    action: string;
    payload: Record<string, unknown>;
    /** Hashes of causally-preceding entries at the time this was recorded. */
    parentHashes: string[];
    /** sha256 of the canonical serialisation of all other fields. */
    hash: string;
    createdAt: Date;
}
export interface VerifyResult {
    valid: boolean;
    entryCount: number;
    /** Leaf entries — no other entry lists them as a parent. */
    tips: string[];
    /** Root entries — recorded with no parents (first events). */
    roots: string[];
    errors: string[];
}
export interface AuditLog {
    /** Record an event; returns the full entry including computed hash. */
    record(entry: Omit<AuditEntry, "id" | "createdAt" | "hash" | "parentHashes">): Promise<AuditEntry>;
    query(orgId: string, contractId?: string, limit?: number): Promise<AuditEntry[]>;
    /** Traverse the DAG and verify every hash and parent reference. */
    verify(orgId: string, contractId?: string): Promise<VerifyResult>;
}
export declare function computeEntryHash(entry: Omit<AuditEntry, "hash">): Promise<string>;
export declare function verifyEntries(entries: AuditEntry[]): Promise<VerifyResult>;
export declare class MerkleAuditLog implements AuditLog {
    /** All entries keyed by hash for O(1) lookup during verify. */
    private readonly byHash;
    /**
     * Current tip hashes per scope key (orgId:contractId).
     * Tips are entries with no known children — the frontier of the DAG.
     * A new entry consumes all current tips as its parents and becomes the new tip.
     */
    private readonly tips;
    private scope;
    record(partial: Omit<AuditEntry, "id" | "createdAt" | "hash" | "parentHashes">): Promise<AuditEntry>;
    query(orgId: string, contractId?: string, limit?: number): Promise<AuditEntry[]>;
    verify(orgId: string, contractId?: string): Promise<VerifyResult>;
}
/** @deprecated Use MerkleAuditLog */
export { MerkleAuditLog as InMemoryAuditLog };
//# sourceMappingURL=audit.d.ts.map