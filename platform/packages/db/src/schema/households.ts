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
  // When true, the concierge line's inbound handler emits an
  // instant "Got it, I'll follow up" reply to the customer before
  // the manager reviews. That reply is agent-authored and goes to
  // the customer without human approval — a violation of the
  // manager-mediated-only model, so it defaults off. A household
  // whose customer expects a fast automated ack (a shared line,
  // out-of-hours coverage) can turn it on per household. STOP /
  // START consent confirmations and verification confirmations
  // are legally / transactionally required and remain unconditional.
  instantAckEnabled: text("instant_ack_enabled", { enum: ["yes", "no"] })
    .notNull()
    .default("no"),
});

export type HouseholdRow = typeof households.$inferSelect;
export type NewHouseholdRow = typeof households.$inferInsert;
