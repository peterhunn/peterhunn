import { sqliteTable, text, primaryKey } from "drizzle-orm/sqlite-core";
import { households } from "./households.js";

// Per-household, per-provider sync cursor. Each provider adapter
// stores an opaque JSON cursor here after a successful pull — for
// Gmail it's { historyId }, for other providers it'll carry whatever
// their delta API needs. Nothing else looks at the cursor payload;
// it's read + written verbatim by the adapter that produced it.
export const syncState = sqliteTable(
  "sync_state",
  {
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    cursor: text("cursor", { mode: "json" }).notNull(),
    updatedAt: text("updated_at").notNull(),
    lastResult: text("last_result", { mode: "json" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.householdId, t.provider] }),
  }),
);

export type SyncStateRow = typeof syncState.$inferSelect;
export type NewSyncStateRow = typeof syncState.$inferInsert;
