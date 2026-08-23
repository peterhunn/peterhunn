import { eq, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { auditExportState, type AuditExportStateRow } from "../schema/audit_export.js";

export interface AuditExportCursor {
  readonly sink: string;
  readonly lastExportedEventId: string | null;
  readonly lastExportedAt: string | null;
  readonly batchesExported: number;
  readonly eventsExported: number;
}

const toCursor = (r: AuditExportStateRow): AuditExportCursor => ({
  sink: r.sink,
  lastExportedEventId: r.lastExportedEventId,
  lastExportedAt: r.lastExportedAt,
  batchesExported: r.batchesExported,
  eventsExported: r.eventsExported,
});

export const auditExportRepo = (db: Db) => ({
  get(sink: string): AuditExportCursor {
    const row = db
      .select()
      .from(auditExportState)
      .where(eq(auditExportState.sink, sink))
      .get();
    if (row) return toCursor(row);
    return {
      sink,
      lastExportedEventId: null,
      lastExportedAt: null,
      batchesExported: 0,
      eventsExported: 0,
    };
  },

  advance(input: {
    sink: string;
    lastExportedEventId: string;
    lastExportedAt: string;
    eventsInBatch: number;
  }): void {
    db.insert(auditExportState)
      .values({
        sink: input.sink,
        lastExportedEventId: input.lastExportedEventId,
        lastExportedAt: input.lastExportedAt,
        batchesExported: 1,
        eventsExported: input.eventsInBatch,
      })
      .onConflictDoUpdate({
        target: auditExportState.sink,
        set: {
          lastExportedEventId: input.lastExportedEventId,
          lastExportedAt: input.lastExportedAt,
          batchesExported: sql`${auditExportState.batchesExported} + 1`,
          eventsExported: sql`${auditExportState.eventsExported} + ${input.eventsInBatch}`,
        },
      })
      .run();
  },

  list(): AuditExportCursor[] {
    return db.select().from(auditExportState).all().map(toCursor);
  },
});
