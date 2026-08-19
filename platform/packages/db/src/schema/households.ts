import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const households = sqliteTable("households", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  tier: text("tier", { enum: ["life", "executive", "private"] }).notNull(),
  riskTier: text("risk_tier", { enum: ["standard", "elevated", "hnw"] })
    .notNull()
    .default("standard"),
  createdAt: text("created_at").notNull(),
  archivedAt: text("archived_at"),
  frozenAt: text("frozen_at"),
  frozenReason: text("frozen_reason"),
  // When true, the background scheduler dispatches an agent run for
  // each newly-synced inbox message and calendar event, so proposed
  // actions land in the approval queue without a manager clicking
  // Run intent. Defaults on; a manager can toggle per household.
  autopilotEnabled: text("autopilot_enabled", { enum: ["yes", "no"] })
    .notNull()
    .default("yes"),
});

export type HouseholdRow = typeof households.$inferSelect;
export type NewHouseholdRow = typeof households.$inferInsert;
