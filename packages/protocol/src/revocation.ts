/**
 * x490 token revocation support.
 *
 * RevocationStore is the interface servers implement to track revoked contractIds.
 * InMemoryRevocationStore is a zero-dependency default for demos and testing.
 * Production deployments should back this with a database or distributed cache.
 */

export interface RevocationStore {
  /** Mark contractId as revoked. Reason is for audit purposes only. */
  revoke(contractId: string, reason?: string): Promise<void>;
  /** Return true if contractId has been revoked. */
  isRevoked(contractId: string): Promise<boolean>;
}

export class InMemoryRevocationStore implements RevocationStore {
  private readonly revoked = new Map<string, string | undefined>();

  async revoke(contractId: string, reason?: string): Promise<void> {
    this.revoked.set(contractId, reason);
  }

  async isRevoked(contractId: string): Promise<boolean> {
    return this.revoked.has(contractId);
  }
}
