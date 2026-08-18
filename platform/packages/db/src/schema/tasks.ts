import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { households } from "./households.js";

// Agent task ledger. Every intent handled by the orchestrator produces
// a run row and one or more task rows. Tasks are correlated by
// orchestrator_run_id for full-DAG replay.
export const orchestratorRuns = sqliteTable(
  "orchestrator_runs",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    intentKind: text("intent_kind").notNull(),
    intentAttrs: text("intent_attrs", { mode: "json" }).notNull(),
    origin: text("origin", { enum: ["customer", "manager", "proactive", "system"] }).notNull(),
    originBy: text("origin_by").notNull(),
    state: text("state", {
      enum: ["running", "completed", "failed", "partial"],
    }).notNull(),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at"),
  },
  (t) => ({
    householdCreatedAtIdx: index("orch_runs_household_created_at_idx").on(
      t.householdId,
      t.createdAt,
    ),
  }),
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => orchestratorRuns.id, { onDelete: "cascade" }),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    agent: text("agent").notNull(),
    agentVersion: text("agent_version").notNull(),
    kind: text("kind").notNull(),
    inputs: text("inputs", { mode: "json" }).notNull(),
    outputs: text("outputs", { mode: "json" }),
    state: text("state", {
      enum: [
        "received",
        "planning",
        "executing",
        "proposing_action",
        "escalated",
        "completed",
        "rejected",
        "failed",
        "shelved",
      ],
    }).notNull(),
    decisionSummary: text("decision_summary"),
    errorMessage: text("error_message"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    runIdx: index("tasks_run_idx").on(t.runId),
    householdCreatedAtIdx: index("tasks_household_created_at_idx").on(
      t.householdId,
      t.createdAt,
    ),
  }),
);

export type OrchestratorRunRow = typeof orchestratorRuns.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;
