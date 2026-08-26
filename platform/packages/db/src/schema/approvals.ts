import { sqliteTable, text, real, index } from "drizzle-orm/sqlite-core";
import { households } from "./households.js";
import { orchestratorRuns, tasks } from "./tasks.js";

export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => orchestratorRuns.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),

    kind: text("kind", { enum: ["manager_review", "customer_approval"] }).notNull(),
    approverType: text("approver_type", { enum: ["principal", "manager"] }).notNull(),
    approverId: text("approver_id"),

    domain: text("domain").notNull(),
    actionClass: text("action_class").notNull(),
    toolName: text("tool_name").notNull(),
    toolVersion: text("tool_version").notNull(),
    toolInputs: text("tool_inputs", { mode: "json" }).notNull(),
    proposedAttrs: text("proposed_attrs", { mode: "json" }).notNull(),
    subjectPrincipalId: text("subject_principal_id"),
    amountUsd: real("amount_usd"),
    summary: text("summary").notNull(),

    authorityPolicyId: text("authority_policy_id"),
    proposedByAgent: text("proposed_by_agent").notNull(),
    proposedByAgentVersion: text("proposed_by_agent_version").notNull(),
    // The origin that kicked off the run this approval belongs to
    // — customer/manager/proactive/system, plus a free-text label
    // like "autopilot:inbox" or the manager's actor id. Denormalised
    // from orchestrator_runs so the approval card doesn't need a
    // join to answer "who kicked this off?".
    origin: text("origin", {
      enum: ["customer", "manager", "proactive", "system"],
    }),
    originBy: text("origin_by"),
    reasons: text("reasons", { mode: "json" }).notNull().default("[]"),

    state: text("state", {
      enum: ["pending", "approved", "approved_with_edit", "rejected", "expired", "canceled"],
    })
      .notNull()
      .default("pending"),
    resolvedByType: text("resolved_by_type", { enum: ["principal", "manager"] }),
    resolvedById: text("resolved_by_id"),
    resolvedAt: text("resolved_at"),
    resolutionNote: text("resolution_note"),
    resultActionId: text("result_action_id"),

    deadlineAt: text("deadline_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    householdStateIdx: index("approvals_household_state_idx").on(t.householdId, t.state),
    runIdx: index("approvals_run_idx").on(t.runId),
    taskIdx: index("approvals_task_idx").on(t.taskId),
  }),
);

export type ApprovalRow = typeof approvals.$inferSelect;
export type NewApprovalRow = typeof approvals.$inferInsert;
