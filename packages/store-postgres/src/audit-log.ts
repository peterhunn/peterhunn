import type postgres from "postgres";
import type { AuditLog, AuditEntry, VerifyResult } from "@legal-agents/api";
import { computeEntryHash, verifyEntries } from "@legal-agents/api";

type Sql = ReturnType<typeof postgres>;

interface AuditRow {
  id: string;
  org_id: string;
  key_id: string;
  contract_id: string | null;
  action: string;
  payload: unknown;
  parent_hashes: string[];
  hash: string;
  created_at: Date;
}

function rowToEntry(r: AuditRow): AuditEntry {
  return {
    id: r.id,
    orgId: r.org_id,
    keyId: r.key_id,
    ...(r.contract_id !== null ? { contractId: r.contract_id } : {}),
    action: r.action,
    payload: r.payload as AuditEntry["payload"],
    parentHashes: r.parent_hashes,
    hash: r.hash,
    createdAt: r.created_at,
  };
}

/**
 * Postgres-backed Merkle DAG audit log.
 *
 * Tips are maintained in `audit_log_tips` transactionally with each insert,
 * giving O(1) tip lookup rather than a full table scan.
 *
 * `scope` in audit_log_tips is the contract_id as text, or '' for org-level
 * entries (those with no contract_id).
 */
export class PostgresAuditLog implements AuditLog {
  constructor(private readonly sql: Sql) {}

  async record(
    partial: Omit<AuditEntry, "id" | "createdAt" | "hash" | "parentHashes">,
  ): Promise<AuditEntry> {
    const scope = partial.contractId ?? "";

    return await this.sql.begin(async (tx) => {
      // 1. Fetch current tips for this (org, scope)
      const tipRows = await tx<{ hash: string }[]>`
        SELECT hash FROM audit_log_tips
        WHERE org_id = ${partial.orgId} AND scope = ${scope}
        FOR UPDATE
      `;
      const parentHashes = tipRows.map((r) => r.hash);

      // 2. Compute the new entry and its hash
      const base: Omit<AuditEntry, "hash"> = {
        ...partial,
        id: crypto.randomUUID(),
        createdAt: new Date(),
        parentHashes,
      };
      const hash = await computeEntryHash(base);
      const entry: AuditEntry = { ...base, hash };

      // 3. Insert the entry
      await tx`
        INSERT INTO audit_log
          (id, org_id, key_id, contract_id, action, payload, parent_hashes, hash, created_at)
        VALUES (
          ${entry.id},
          ${entry.orgId},
          ${entry.keyId},
          ${entry.contractId ?? null},
          ${entry.action},
          ${tx.json(entry.payload as never)},
          ${tx.array(entry.parentHashes)},
          ${entry.hash},
          ${entry.createdAt}
        )
      `;

      // 4. Remove consumed parent hashes from tips, insert the new tip
      if (parentHashes.length > 0) {
        await tx`
          DELETE FROM audit_log_tips
          WHERE org_id = ${entry.orgId}
            AND scope  = ${scope}
            AND hash   = ANY(${tx.array(parentHashes)})
        `;
      }
      await tx`
        INSERT INTO audit_log_tips (org_id, scope, hash)
        VALUES (${entry.orgId}, ${scope}, ${entry.hash})
        ON CONFLICT DO NOTHING
      `;

      return entry;
    });
  }

  async query(
    orgId: string,
    contractId?: string,
    limit = 100,
  ): Promise<AuditEntry[]> {
    const rows = contractId
      ? await this.sql<AuditRow[]>`
          SELECT id, org_id, key_id, contract_id, action, payload,
                 parent_hashes, hash, created_at
          FROM audit_log
          WHERE org_id = ${orgId} AND contract_id = ${contractId}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `
      : await this.sql<AuditRow[]>`
          SELECT id, org_id, key_id, contract_id, action, payload,
                 parent_hashes, hash, created_at
          FROM audit_log
          WHERE org_id = ${orgId}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `;
    return rows.map(rowToEntry);
  }

  async verify(orgId: string, contractId?: string): Promise<VerifyResult> {
    // Fetch all entries (no limit) — needed to traverse the full DAG
    const rows = contractId
      ? await this.sql<AuditRow[]>`
          SELECT id, org_id, key_id, contract_id, action, payload,
                 parent_hashes, hash, created_at
          FROM audit_log
          WHERE org_id = ${orgId} AND contract_id = ${contractId}
          ORDER BY created_at ASC
        `
      : await this.sql<AuditRow[]>`
          SELECT id, org_id, key_id, contract_id, action, payload,
                 parent_hashes, hash, created_at
          FROM audit_log
          WHERE org_id = ${orgId}
          ORDER BY created_at ASC
        `;
    return verifyEntries(rows.map(rowToEntry));
  }
}
