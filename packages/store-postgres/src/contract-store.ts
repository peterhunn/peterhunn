import type postgres from "postgres";
import type { ContractStore, StoredContract } from "@legal-agents/api";

type Sql = ReturnType<typeof postgres>;

interface ContractRow {
  id: string;
  org_id: string;
  contract_type: string;
  data: unknown;
  state: unknown;
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

    const row = rows[0];
    if (!row) return undefined;
    return {
      orgId: row.org_id,
      contractType: row.contract_type,
      data: row.data as StoredContract["data"],
      state: row.state as StoredContract["state"],
    };
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
}
