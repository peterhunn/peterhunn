/**
 * x490 multi-party contract support.
 *
 * PendingContractStore tracks contracts that need more than one party to sign.
 * The first acceptor creates a pending entry; subsequent parties co-sign by
 * supplying pendingContractId in their AcceptRequest. When all required parties
 * have signed, the store transitions the record to "complete" and the server
 * issues a token.
 */

export interface PendingEntry {
  contractId: string;
  templateHash: string;
  requiredParties: number;
  acceptances: Array<{ partyId: string; partyData: Record<string, string>; at: number }>;
}

export interface PendingContractStore {
  /** Create a new pending contract. Returns the stored entry. */
  create(entry: Omit<PendingEntry, "acceptances">): Promise<PendingEntry>;
  /** Add a co-signer to an existing pending contract. Returns updated entry or null if not found. */
  addParty(
    contractId: string,
    partyId: string,
    partyData: Record<string, string>,
  ): Promise<PendingEntry | null>;
  /** Retrieve a pending entry by contractId, or null if not found / already completed. */
  get(contractId: string): Promise<PendingEntry | null>;
  /** Mark as complete (all parties signed). */
  complete(contractId: string): Promise<void>;
}

export class InMemoryPendingContractStore implements PendingContractStore {
  private readonly store = new Map<string, PendingEntry>();

  async create(entry: Omit<PendingEntry, "acceptances">): Promise<PendingEntry> {
    const full: PendingEntry = { ...entry, acceptances: [] };
    this.store.set(entry.contractId, full);
    return full;
  }

  async addParty(
    contractId: string,
    partyId: string,
    partyData: Record<string, string>,
  ): Promise<PendingEntry | null> {
    const entry = this.store.get(contractId);
    if (!entry) return null;
    entry.acceptances.push({ partyId, partyData, at: Math.floor(Date.now() / 1000) });
    return entry;
  }

  async get(contractId: string): Promise<PendingEntry | null> {
    return this.store.get(contractId) ?? null;
  }

  async complete(contractId: string): Promise<void> {
    this.store.delete(contractId);
  }
}
