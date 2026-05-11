import type postgres from "postgres";
import type { ContractStore, StoredContract, DueContract } from "@legal-agents/api";

type Sql = ReturnType<typeof postgres>;

interface ContractRow {
  id: string;
  org_id: string;
  contract_type: string;
  data: unknown;
  state: unknown;
}

function rowToStoredContract(row: ContractRow): StoredContract {
  return {
    orgId: row.org_id,
    contractType: row.contract_type,
    data: row.data as StoredContract["data"],
    state: row.state as StoredContract["state"],
  };
}

export class PostgresContractStore implements ContractStore {
  constructor(private readonly sql: Sql) {}

  async get(
    contractId: string,
    orgId?: string,
  ): Promise<StoredContract | undefined> {
    const rows = orgId
      ? await this.sql<ContractRow[]>`
          SELECT id, org_id, contract_type, data, state
          FROM contracts
          WHERE id = ${contractId} AND org_id = ${orgId}
        `
      : await this.sql<ContractRow[]>`
          SELECT id, org_id, contract_type, data, state
          FROM contracts
          WHERE id = ${contractId}
        `;
    return rows[0] ? rowToStoredContract(rows[0]) : undefined;
  }

  async set(contractId: string, contract: StoredContract): Promise<void> {
    await this.sql`
      INSERT INTO contracts (id, org_id, contract_type, data, state, created_at, updated_at)
      VALUES (
        ${contractId},
        ${contract.orgId},
        ${contract.contractType},
        ${this.sql.json(contract.data as object)},
        ${this.sql.json(contract.state as object)},
        now(),
        now()
      )
      ON CONFLICT (id) DO UPDATE
        SET state      = EXCLUDED.state,
            updated_at = now()
    `;
  }

  async delete(contractId: string): Promise<void> {
    await this.sql`DELETE FROM contracts WHERE id = ${contractId}`;
  }

  async findWithDueObligations(now: Date): Promise<DueContract[]> {
    // Find all active contracts with at least one pending obligation whose
    // deadline has passed. The JSONB path query checks obligation status and
    // deadline using the same shape as ContractState.obligations[].
    const rows = await this.sql<ContractRow[]>`
      SELECT id, org_id, contract_type, data, state
      FROM contracts
      WHERE state->>'status' = 'active'
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(state->'obligations') AS o
          WHERE o->>'status' = 'pending'
            AND o->>'deadline' IS NOT NULL
            AND (o->>'deadline')::timestamptz <= ${now.toISOString()}::timestamptz
        )
    `;
    return rows.map((r) => ({
      contractId: r.id,
      stored: rowToStoredContract(r),
    }));
  }
}
