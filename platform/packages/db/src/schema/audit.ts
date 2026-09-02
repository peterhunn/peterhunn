import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { households } from "./households.js";

// Access log across the graph, content, credential, and console layers.
// Sensitive reads land here too, not just writes. See
// docs/23-data-model.md §"Audit".
export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),

    actorType: text("actor_type", {
      enum: ["customer", "manager", "agent", "system"],
    }).notNull(),
    actorId: text("actor_id").notNull(),

    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),

    sensitive: text("sensitive", { enum: ["yes", "no"] })
      .notNull()
      .default("no"),
    metadata: text("metadata", { mode: "json" }).default("{}"),

    at: text("at").notNull(),
  },
  (t) => ({
    householdAtIdx: index("audit_household_at_idx").on(t.householdId, t.at),
    resourceIdx: index("audit_resource_idx").on(t.resourceType, t.resourceId),
  }),
);

export type AuditEventRow = typeof auditEvents.$inferSelect;
export type NewAuditEventRow = typeof auditEvents.$inferInsert;
