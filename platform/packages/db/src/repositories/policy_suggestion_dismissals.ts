import { and, eq } from "drizzle-orm";
import { nowIso, type HouseholdId } from "@atelier/domain";
import type { Db } from "../client.js";
import {
  policySuggestionDismissals,
  type PolicySuggestionDismissalRow,
} from "../schema/policy_suggestion_dismissals.js";

// Persist a manager's "not right now" on an autonomy-ladder
// promotion suggestion. The suggestion stays hidden until the
// pattern's streak breaks (a rejection or edit in the window)
// — checked in apps/api/src/policy-suggestions.ts, not here.

export interface UpsertDismissalInput {
  readonly householdId: HouseholdId;
  readonly actionClass: string;
  readonly subjectPrincipalId: string | null;
  readonly dismissedAtApprovalId: string;
  readonly dismissedBy: string;
}

const subjectKey = (s: string | null): string => s ?? "_any";

export const policySuggestionDismissalRepo = (db: Db) => ({
  upsert(input: UpsertDismissalInput): PolicySuggestionDismissalRow {
    const now = nowIso();
    const values = {
      householdId: input.householdId,
      actionClass: input.actionClass,
      subjectPrincipalId: subjectKey(input.subjectPrincipalId),
      dismissedAtApprovalId: input.dismissedAtApprovalId,
      dismissedAt: now,
      dismissedBy: input.dismissedBy,
    };
    db.insert(policySuggestionDismissals)
      .values(values)
      .onConflictDoUpdate({
        target: [
          policySuggestionDismissals.householdId,
          policySuggestionDismissals.actionClass,
          policySuggestionDismissals.subjectPrincipalId,
        ],
        set: {
          dismissedAtApprovalId: values.dismissedAtApprovalId,
          dismissedAt: values.dismissedAt,
          dismissedBy: values.dismissedBy,
        },
      })
      .run();
    const row = db
      .select()
      .from(policySuggestionDismissals)
      .where(
        and(
          eq(policySuggestionDismissals.householdId, input.householdId),
          eq(policySuggestionDismissals.actionClass, input.actionClass),
          eq(
            policySuggestionDismissals.subjectPrincipalId,
            subjectKey(input.subjectPrincipalId),
          ),
        ),
      )
      .get();
    if (!row) throw new Error("dismissal upsert did not return");
    return row;
  },

  list(householdId: HouseholdId): PolicySuggestionDismissalRow[] {
    return db
      .select()
      .from(policySuggestionDismissals)
      .where(eq(policySuggestionDismissals.householdId, householdId))
      .all();
  },

  clear(input: {
    householdId: HouseholdId;
    actionClass: string;
    subjectPrincipalId: string | null;
  }): void {
    db.delete(policySuggestionDismissals)
      .where(
        and(
          eq(policySuggestionDismissals.householdId, input.householdId),
          eq(policySuggestionDismissals.actionClass, input.actionClass),
          eq(
            policySuggestionDismissals.subjectPrincipalId,
            subjectKey(input.subjectPrincipalId),
          ),
        ),
      )
      .run();
  },
});
