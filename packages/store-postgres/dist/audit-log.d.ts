import type postgres from "postgres";
import type { AuditLog, AuditEntry, VerifyResult } from "@legal-agents/api";
type Sql = ReturnType<typeof postgres>;
/**
 * Postgres-backed Merkle DAG audit log.
 *
 * Tips are maintained in `audit_log_tips` transactionally with each insert,
 * giving O(1) tip lookup rather than a full table scan.
 *
 * `scope` in audit_log_tips is the contract_id as text, or '' for org-level
 * entries (those with no contract_id).
 */
export declare class PostgresAuditLog implements AuditLog {
    private readonly sql;
    constructor(sql: Sql);
    record(partial: Omit<AuditEntry, "id" | "createdAt" | "hash" | "parentHashes">): Promise<AuditEntry>;
    query(orgId: string, contractId?: string, limit?: number): Promise<AuditEntry[]>;
    verify(orgId: string, contractId?: string): Promise<VerifyResult>;
}
export {};
//# sourceMappingURL=audit-log.d.ts.map