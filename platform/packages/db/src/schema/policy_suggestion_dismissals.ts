import { sqliteTable, text, primaryKey } from "drizzle-orm/sqlite-core";
import { households } from "./households.js";

// A manager can dismiss a promotion suggestion for a given
// (action_class, subject_principal_id) pattern. The dismissal is
// persistent until the streak breaks (a rejection in the window) —
// then the pattern becomes fresh and a new streak can re-earn a
// suggestion. Storing the dismiss watermark rather than a boolean
// lets us re-suggest automatically after real change without
// forcing the manager to re-visit.
//
// One row per (household, action_class, subject_principal_id). The
// subject uses the sentinel string "_any" when the suggestion was
// for the household wildcard (matches the bucket key shape in
// apps/api/src/policy-suggestions.ts).
export const policySuggestionDismissals = sqliteTable(
  "policy_suggestion_dismissals",
  {
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    actionClass: text("action_class").notNull(),
    subjectPrincipalId: text("subject_principal_id").notNull(),
    // The head approval id at the moment of dismissal. Used to
    // detect "the streak has changed since we dismissed" so a new
    // suggestion can be re-emitted without manual reset.
    dismissedAtApprovalId: text("dismissed_at_approval_id").notNull(),
    dismissedAt: text("dismissed_at").notNull(),
    dismissedBy: text("dismissed_by").notNull(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.householdId, t.actionClass, t.subjectPrincipalId],
    }),
  }),
);

export type PolicySuggestionDismissalRow =
  typeof policySuggestionDismissals.$inferSelect;
export type NewPolicySuggestionDismissalRow =
  typeof policySuggestionDismissals.$inferInsert;
