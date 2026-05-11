import type { ContractData, ContractState } from "@legal-agents/core";

export interface StoredContract {
  orgId: string;
  contractType: string;
  data: ContractData;
  state: ContractState;
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
}

export class InMemoryStore implements ContractStore {
  private readonly map = new Map<string, StoredContract>();

  async get(
    contractId: string,
    orgId?: string,
  ): Promise<StoredContract | undefined> {
    const stored = this.map.get(contractId);
    if (!stored) return undefined;
    if (orgId !== undefined && stored.orgId !== orgId) return undefined;
    return stored;
  }

  async set(contractId: string, contract: StoredContract): Promise<void> {
    this.map.set(contractId, contract);
  }

  async delete(contractId: string): Promise<void> {
    this.map.delete(contractId);
  }
}
