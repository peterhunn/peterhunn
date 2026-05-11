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
  record(
    entry: Omit<AuditEntry, "id" | "createdAt" | "hash" | "parentHashes">,
  ): Promise<AuditEntry>;
  query(
    orgId: string,
    contractId?: string,
    limit?: number,
  ): Promise<AuditEntry[]>;
  /** Traverse the DAG and verify every hash and parent reference. */
  verify(orgId: string, contractId?: string): Promise<VerifyResult>;
}

// ── Canonical hash ────────────────────────────────────────────────────────────

/**
 * RFC 8785-style canonical JSON: objects sorted by key, no whitespace.
 * Used so the hash is reproducible by any external tool.
 */
function canonicalize(val: unknown): string {
  if (val === null || typeof val !== "object") return JSON.stringify(val);
  if (Array.isArray(val)) return `[${val.map(canonicalize).join(",")}]`;
  const keys = Object.keys(val as object).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((val as Record<string, unknown>)[k])}`).join(",")}}`;
}

export async function computeEntryHash(
  entry: Omit<AuditEntry, "hash">,
): Promise<string> {
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
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── DAG verification ──────────────────────────────────────────────────────────

export async function verifyEntries(
  entries: AuditEntry[],
): Promise<VerifyResult> {
  const byHash = new Map(entries.map((e) => [e.hash, e]));
  const errors: string[] = [];

  for (const entry of entries) {
    // Recompute hash and compare
    const { hash, ...rest } = entry;
    const expected = await computeEntryHash(rest);
    if (expected !== hash) {
      errors.push(
        `Entry ${entry.id} (${entry.action}): hash mismatch — content has been tampered`,
      );
    }

    // Verify every parent exists in this scope
    for (const parentHash of entry.parentHashes) {
      if (!byHash.has(parentHash)) {
        errors.push(
          `Entry ${entry.id} (${entry.action}): parent ${parentHash.slice(0, 12)}… not found — an entry may have been deleted`,
        );
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

export class MerkleAuditLog implements AuditLog {
  /** All entries keyed by hash for O(1) lookup during verify. */
  private readonly byHash = new Map<string, AuditEntry>();
  /**
   * Current tip hashes per scope key (orgId:contractId).
   * Tips are entries with no known children — the frontier of the DAG.
   * A new entry consumes all current tips as its parents and becomes the new tip.
   */
  private readonly tips = new Map<string, Set<string>>();

  private scope(orgId: string, contractId?: string): string {
    return `${orgId}:${contractId ?? ""}`;
  }

  async record(
    partial: Omit<AuditEntry, "id" | "createdAt" | "hash" | "parentHashes">,
  ): Promise<AuditEntry> {
    const scope = this.scope(partial.orgId, partial.contractId);
    const parentHashes = [...(this.tips.get(scope) ?? new Set<string>())];

    const base: Omit<AuditEntry, "hash"> = {
      ...partial,
      id: crypto.randomUUID(),
      createdAt: new Date(),
      parentHashes,
    };
    const hash = await computeEntryHash(base);
    const entry: AuditEntry = { ...base, hash };

    this.byHash.set(hash, entry);
    this.tips.set(scope, new Set([hash]));
    return entry;
  }

  async query(
    orgId: string,
    contractId?: string,
    limit = 100,
  ): Promise<AuditEntry[]> {
    return [...this.byHash.values()]
      .filter(
        (e) =>
          e.orgId === orgId &&
          (contractId === undefined || e.contractId === contractId),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async verify(orgId: string, contractId?: string): Promise<VerifyResult> {
    const entries = [...this.byHash.values()].filter(
      (e) =>
        e.orgId === orgId &&
        (contractId === undefined || e.contractId === contractId),
    );
    return verifyEntries(entries);
  }
}

/** @deprecated Use MerkleAuditLog */
export { MerkleAuditLog as InMemoryAuditLog };
