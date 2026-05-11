import type { ContractData, ContractState } from "@legal-agents/core";

export interface StoredContract {
  contractType: string;
  data: ContractData;
  state: ContractState;
}

/**
 * Persistence interface for live contract instances.
 *
 * Swap InMemoryStore for a Redis or Postgres implementation in production.
 */
export interface ContractStore {
  get(contractId: string): Promise<StoredContract | undefined>;
  set(contractId: string, contract: StoredContract): Promise<void>;
  delete(contractId: string): Promise<void>;
}

export class InMemoryStore implements ContractStore {
  private readonly map = new Map<string, StoredContract>();

  async get(contractId: string): Promise<StoredContract | undefined> {
    return this.map.get(contractId);
  }

  async set(contractId: string, contract: StoredContract): Promise<void> {
    this.map.set(contractId, contract);
  }

  async delete(contractId: string): Promise<void> {
    this.map.delete(contractId);
  }
}
