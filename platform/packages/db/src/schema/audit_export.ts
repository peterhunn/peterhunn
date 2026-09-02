import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// Cursor for the audit-event streaming exporter. Exactly one row
// per sink name (unique). Tracks the last event we've handed to
// that sink so the next tick picks up from there without
// re-emitting a duplicate. `lastExportedAt` lets an operator see
// "how stale is my SIEM feed" at a glance.
//
// A batch commits atomically: sink.writeBatch() must return only
// after the events are durably persisted; only then does the
// cursor row get updated. Sink failure leaves the cursor
// untouched, so the next tick retries the same window.
export const auditExportState = sqliteTable("audit_export_state", {
  sink: text("sink").primaryKey(),
  lastExportedEventId: text("last_exported_event_id"),
  lastExportedAt: text("last_exported_at"),
  batchesExported: integer("batches_exported").notNull().default(0),
  eventsExported: integer("events_exported").notNull().default(0),
});

export type AuditExportStateRow = typeof auditExportState.$inferSelect;
