import { sqliteTable, text, real, index } from "drizzle-orm/sqlite-core";
import { households } from "./households.js";

// Graph nodes. Every node is scoped to exactly one household.
// `data` is a JSON blob whose shape is constrained by `type` via the
// domain package's node schemas (validated at write time in the API
// layer). `superseded_by` implements soft versioning: a retired node
// remains queryable but is hidden from active graph reads.
export const nodes = sqliteTable(
  "nodes",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    data: text("data", { mode: "json" }).notNull(),

    provenanceSource: text("provenance_source").notNull(),
    provenanceSourceRef: text("provenance_source_ref"),
    provenanceAssertedBy: text("provenance_asserted_by").notNull(),
    provenanceAssertedAt: text("provenance_asserted_at").notNull(),
    provenanceConfidence: real("provenance_confidence").notNull(),
    provenanceStatus: text("provenance_status", {
      enum: ["candidate", "confirmed", "retired"],
    }).notNull(),

    createdAt: text("created_at").notNull(),
    supersededBy: text("superseded_by"),
    supersededAt: text("superseded_at"),
  },
  (t) => ({
    householdTypeIdx: index("nodes_household_type_idx").on(t.householdId, t.type),
    householdStatusIdx: index("nodes_household_status_idx").on(
      t.householdId,
      t.provenanceStatus,
    ),
  }),
);

export type NodeRow = typeof nodes.$inferSelect;
export type NewNodeRow = typeof nodes.$inferInsert;
