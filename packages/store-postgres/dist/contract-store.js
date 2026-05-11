function rowToStoredContract(row) {
    return {
        orgId: row.org_id,
        contractType: row.contract_type,
        data: row.data,
        state: row.state,
    };
}
export class PostgresContractStore {
    sql;
    constructor(sql) {
        this.sql = sql;
    }
    async get(contractId, orgId) {
        const rows = orgId
            ? await this.sql `
          SELECT id, org_id, contract_type, data, state
          FROM contracts
          WHERE id = ${contractId} AND org_id = ${orgId}
        `
            : await this.sql `
          SELECT id, org_id, contract_type, data, state
          FROM contracts
          WHERE id = ${contractId}
        `;
        return rows[0] ? rowToStoredContract(rows[0]) : undefined;
    }
    async set(contractId, contract) {
        await this.sql `
      INSERT INTO contracts (id, org_id, contract_type, data, state, created_at, updated_at)
      VALUES (
        ${contractId},
        ${contract.orgId},
        ${contract.contractType},
        ${this.sql.json(contract.data)},
        ${this.sql.json(contract.state)},
        now(),
        now()
      )
      ON CONFLICT (id) DO UPDATE
        SET state      = EXCLUDED.state,
            updated_at = now()
    `;
    }
    async delete(contractId) {
        await this.sql `DELETE FROM contracts WHERE id = ${contractId}`;
    }
    async findWithDueObligations(now) {
        // Find all active contracts with at least one pending obligation whose
        // deadline has passed. The JSONB path query checks obligation status and
        // deadline using the same shape as ContractState.obligations[].
        const rows = await this.sql `
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
//# sourceMappingURL=contract-store.js.map