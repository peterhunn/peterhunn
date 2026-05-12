import type { ContractData, ContractState } from "@x490/core";

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

  async findWithDueObligations(now: Date): Promise<DueContract[]> {
    const result: DueContract[] = [];
    for (const [contractId, stored] of this.map) {
      if (stored.state.status !== "active") continue;
      const hasDue = stored.state.obligations.some(
        (o) =>
          o.status === "pending" &&
          o.deadline !== undefined &&
          new Date(o.deadline) <= now,
      );
      if (hasDue) result.push({ contractId, stored });
    }
    return result;
  }
}
