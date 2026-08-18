import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";
import { households } from "./households.js";

// Every LLM call the router fulfils lands here. Household is nullable
// because some calls (evals, warmup, cross-household analytics) aren't
// attributable to a single household — but a customer-serving call
// always is, and unattributed calls never charge a household budget.
export const modelCalls = sqliteTable(
  "model_calls",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").references(() => households.id, {
      onDelete: "set null",
    }),

    taskClass: text("task_class").notNull(),
    minTier: text("min_tier").notNull(),
    selectedTier: text("selected_tier").notNull(),
    modelId: text("model_id").notNull(),
    provider: text("provider").notNull(),

    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    costUsdEstimated: real("cost_usd_estimated").notNull(),
    latencyMs: integer("latency_ms").notNull(),

    finishReason: text("finish_reason").notNull(),
    routerReasons: text("router_reasons", { mode: "json" }).notNull().default("[]"),
    inputHash: text("input_hash").notNull(),
    outputHash: text("output_hash").notNull(),

    triggeringRunId: text("triggering_run_id"),
    triggeringTaskId: text("triggering_task_id"),

    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    householdCreatedAtIdx: index("model_calls_household_created_at_idx").on(
      t.householdId,
      t.createdAt,
    ),
    taskClassIdx: index("model_calls_task_class_idx").on(t.taskClass),
  }),
);

export type ModelCallRow = typeof modelCalls.$inferSelect;
export type NewModelCallRow = typeof modelCalls.$inferInsert;
