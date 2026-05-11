import type postgres from "postgres";
import type { AuditLog, AuditEntry } from "@legal-agents/api";

type Sql = ReturnType<typeof postgres>;

interface AuditRow {
  id: string;
  org_id: string;
  key_id: string;
  contract_id: string | null;
  action: string;
  payload: unknown;
  created_at: Date;
}

export class PostgresAuditLog implements AuditLog {
  constructor(private readonly sql: Sql) {}

  async record(entry: Omit<AuditEntry, "id" | "createdAt">): Promise<void> {
    await this.sql`
      INSERT INTO audit_log (org_id, key_id, contract_id, action, payload)
      VALUES (
        ${entry.orgId},
        ${entry.keyId},
        ${entry.contractId ?? null},
        ${entry.action},
        ${this.sql.json(entry.payload)}
      )
    `;
  }

  async query(
    orgId: string,
    contractId?: string,
    limit = 100,
  ): Promise<AuditEntry[]> {
    const rows = contractId
      ? await this.sql<AuditRow[]>`
          SELECT id, org_id, key_id, contract_id, action, payload, created_at
          FROM audit_log
          WHERE org_id = ${orgId} AND contract_id = ${contractId}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `
      : await this.sql<AuditRow[]>`
          SELECT id, org_id, key_id, contract_id, action, payload, created_at
          FROM audit_log
          WHERE org_id = ${orgId}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `;

    return rows.map((r) => ({
      id: r.id,
      orgId: r.org_id,
      keyId: r.key_id,
      contractId: r.contract_id ?? undefined,
      action: r.action,
      payload: r.payload as AuditEntry["payload"],
      createdAt: r.created_at,
    }));
  }
}
