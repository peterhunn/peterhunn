import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { households } from "./households.js";

// The action ledger. Append-only in intent — no update path is exposed
// from the repository layer. Every material action a manager or agent
// takes should land here with a full authority trail.
// See ../life-management/permissions.md §"Audit".
export const actions = sqliteTable(
  "actions",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),

    agent: text("agent").notNull(),
    agentVersion: text("agent_version").notNull(),
    tool: text("tool").notNull(),
    toolVersion: text("tool_version").notNull(),

    inputsHash: text("inputs_hash").notNull(),
    outputsHash: text("outputs_hash"),

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
  }),
);

export type ActionRow = typeof actions.$inferSelect;
export type NewActionRow = typeof actions.$inferInsert;
