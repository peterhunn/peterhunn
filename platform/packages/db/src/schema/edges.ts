import { sqliteTable, text, real, index } from "drizzle-orm/sqlite-core";
import { households } from "./households.js";
import { nodes } from "./nodes.js";

export const edges = sqliteTable(
  "edges",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    fromNodeId: text("from_node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    toNodeId: text("to_node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    attrs: text("attrs", { mode: "json" }).notNull().default("{}"),

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
    householdTypeIdx: index("edges_household_type_idx").on(t.householdId, t.type),
    fromNodeIdx: index("edges_from_node_idx").on(t.fromNodeId),
    toNodeIdx: index("edges_to_node_idx").on(t.toNodeId),
  }),
);

export type EdgeRow = typeof edges.$inferSelect;
export type NewEdgeRow = typeof edges.$inferInsert;
