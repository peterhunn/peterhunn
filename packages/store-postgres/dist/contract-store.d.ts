import type postgres from "postgres";
import type { ContractStore, StoredContract, DueContract } from "@legal-agents/api";
type Sql = ReturnType<typeof postgres>;
export declare class PostgresContractStore implements ContractStore {
    private readonly sql;
    constructor(sql: Sql);
    get(contractId: string, orgId?: string): Promise<StoredContract | undefined>;
    set(contractId: string, contract: StoredContract): Promise<void>;
    delete(contractId: string): Promise<void>;
    findWithDueObligations(now: Date): Promise<DueContract[]>;
}
export {};
//# sourceMappingURL=contract-store.d.ts.map