export interface AuditEntry {
  id: string;
  orgId: string;
  keyId: string;
  contractId?: string;
  action: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface AuditLog {
  record(entry: Omit<AuditEntry, "id" | "createdAt">): Promise<void>;
  query(
    orgId: string,
    contractId?: string,
    limit?: number,
  ): Promise<AuditEntry[]>;
}

export class InMemoryAuditLog implements AuditLog {
  private readonly entries: AuditEntry[] = [];

  async record(entry: Omit<AuditEntry, "id" | "createdAt">): Promise<void> {
    this.entries.push({
      ...entry,
      id: crypto.randomUUID(),
      createdAt: new Date(),
    });
  }

  async query(
    orgId: string,
    contractId?: string,
    limit = 100,
  ): Promise<AuditEntry[]> {
    return this.entries
      .filter(
        (e) =>
          e.orgId === orgId &&
          (contractId === undefined || e.contractId === contractId),
      )
      .slice(-limit)
      .reverse();
  }
}
