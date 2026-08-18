import { sqliteTable, text, real, index } from "drizzle-orm/sqlite-core";
import { households } from "./households.js";

// The action ledger. Append-only in intent — no update path is exposed
// from the repository layer except a narrow completion path that sets
// outcome + outputs_hash on a previously-planned action.
// See ../life-management/permissions.md §"Audit".
export const actions = sqliteTable(
  "actions",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),

    subjectPrincipalId: text("subject_principal_id"),

    agent: text("agent").notNull(),
    agentVersion: text("agent_version").notNull(),
    tool: text("tool").notNull(),
    toolVersion: text("tool_version").notNull(),
    actionClass: text("action_class").notNull(),
    domain: text("domain").notNull(),

    inputsHash: text("inputs_hash").notNull(),
    outputsHash: text("outputs_hash"),

    amountUsd: real("amount_usd"),

    policyIdAuthorizing: text("policy_id_authorizing"),
    approverId: text("approver_id"),
    approvalChannel: text("approval_channel"),

    outcome: text("outcome", {
      enum: [
        "planned",
        "in_flight",
        "succeeded",
        "failed_transient",
        "failed_permanent",
        "rolled_back",
      ],
    }).notNull(),
    summary: text("summary").notNull(),

    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at"),
  },
  (t) => ({
    householdCreatedAtIdx: index("actions_household_created_at_idx").on(
      t.householdId,
      t.createdAt,
    ),
    householdOutcomeIdx: index("actions_household_outcome_idx").on(
      t.householdId,
      t.outcome,
    ),
    householdActionClassIdx: index("actions_household_action_class_idx").on(
      t.householdId,
      t.actionClass,
    ),
    householdPolicyIdx: index("actions_household_policy_idx").on(
      t.householdId,
      t.policyIdAuthorizing,
    ),
  }),
);

export type ActionRow = typeof actions.$inferSelect;
export type NewActionRow = typeof actions.$inferInsert;
