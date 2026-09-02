import { sqliteTable, text, primaryKey, index } from "drizzle-orm/sqlite-core";
import { households } from "./households.js";

// Which playbooks are enabled for a household, when each last fired,
// when it's next due, and any per-household config override.
// (playbookId, householdId) is composite primary key — one row per
// (household, playbook).
export const householdPlaybooks = sqliteTable(
  "household_playbooks",
  {
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    playbookId: text("playbook_id").notNull(),
    enabled: text("enabled", { enum: ["yes", "no"] }).notNull().default("yes"),
    config: text("config", { mode: "json" }).notNull(),
    lastFireAt: text("last_fire_at"),
    nextFireAt: text("next_fire_at").notNull(),
    lastRunId: text("last_run_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.householdId, t.playbookId] }),
    nextFireIdx: index("household_playbooks_next_fire_idx").on(t.nextFireAt),
  }),
);

export type HouseholdPlaybookRow = typeof householdPlaybooks.$inferSelect;
