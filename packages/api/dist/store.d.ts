import type { ContractData, ContractState } from "@legal-agents/core";
export interface StoredContract {
    orgId: string;
    contractType: string;
    data: ContractData;
    state: ContractState;
}
export interface DueContract {
    contractId: string;
    stored: StoredContract;
}
export interface ContractStore {
    /**
     * Retrieve a stored contract.
     * When orgId is provided, returns undefined if the contract belongs to a
     * different org — preventing cross-org data access.
     */
    get(contractId: string, orgId?: string): Promise<StoredContract | undefined>;
    set(contractId: string, contract: StoredContract): Promise<void>;
    delete(contractId: string): Promise<void>;
    /**
     * Return all active contracts that have at least one obligation with
     * status "pending" and a deadline at or before `now`.
     * Called by ObligationExecutor on each tick.
     */
    findWithDueObligations(now: Date): Promise<DueContract[]>;
}
export declare class InMemoryStore implements ContractStore {
    private readonly map;
    get(contractId: string, orgId?: string): Promise<StoredContract | undefined>;
    set(contractId: string, contract: StoredContract): Promise<void>;
    delete(contractId: string): Promise<void>;
    findWithDueObligations(now: Date): Promise<DueContract[]>;
}
//# sourceMappingURL=store.d.ts.map