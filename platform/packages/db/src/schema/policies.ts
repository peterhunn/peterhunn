import { sqliteTable, text, real, index } from "drizzle-orm/sqlite-core";
import { households } from "./households.js";

// Policies live as first-class rows here, alongside a JSON spec column
// that carries the DSL shape (scope, limits, approval, window). The
// scalar columns above the spec index the fields used to load a
// candidate policy set for evaluation in one shot, so scope + limit
// application happens in memory rather than in SQL.
export const policies = sqliteTable(
  "policies",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),

    subject: text("subject").notNull(),
    domain: text("domain").notNull(),
    actionClass: text("action_class").notNull(),
    effect: text("effect", { enum: ["allow", "deny"] }).notNull().default("allow"),
    kind: text("kind", { enum: ["standing", "one_time"] }).notNull().default("standing"),
    autonomyRank: real("autonomy_rank").notNull(),

    label: text("label").notNull(),
    spec: text("spec", { mode: "json" }).notNull(),

    provenanceSource: text("provenance_source").notNull(),
    provenanceAssertedBy: text("provenance_asserted_by").notNull(),
    provenanceAssertedAt: text("provenance_asserted_at").notNull(),
    provenanceConfidence: real("provenance_confidence").notNull(),

    createdAt: text("created_at").notNull(),
    revokedAt: text("revoked_at"),
    consumedByActionId: text("consumed_by_action_id"),
  },
  (t) => ({
    matchIdx: index("policies_match_idx").on(
      t.householdId,
      t.domain,
      t.actionClass,
      t.subject,
    ),
    householdIdx: index("policies_household_idx").on(t.householdId),
  }),
);

export type PolicyRow = typeof policies.$inferSelect;
export type NewPolicyRow = typeof policies.$inferInsert;
