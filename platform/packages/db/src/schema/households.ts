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
});

export type HouseholdRow = typeof households.$inferSelect;
export type NewHouseholdRow = typeof households.$inferInsert;
