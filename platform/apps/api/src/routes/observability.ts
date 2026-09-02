import type { FastifyPluginAsync } from "fastify";
import {
  actionRepo,
  modelCallRepo,
  taskRepo,
  type Db,
  type ModelCallRow,
  type TaskRow,
} from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";

// Observability read surface. Everything here is derived from
// existing ledger rows (model_calls, tasks, orchestrator_runs,
// actions) — no new schema. Three endpoints:
//   GET /households/:id/model-calls/daily
//     Daily cost buckets by tier, 30d window default. Cost chart.
//   GET /households/:id/tasks/:taskId/model-calls
//     The T0..T3 calls a specific task made. Trace panel.
//   GET /households/:id/runs/:runId
//     A whole run: intent, per-task list, model calls, actions,
//     built into a chronological timeline. Run drill-down.

interface TimelineEvent {
  readonly at: string;
  readonly kind: "run" | "task" | "model_call" | "action";
  readonly summary: string;
  readonly detail?: Record<string, unknown>;
}

const modelCallSummary = (m: ModelCallRow): string => {
  const cached = m.cachedInputTokens ?? 0;
  const cacheNote = cached > 0 ? ` · cache ${cached}` : "";
  return `${m.taskClass} → ${m.modelId} (${m.selectedTier}) · ${m.inputTokens}+${m.outputTokens}t${cacheNote} · $${m.costUsdEstimated.toFixed(4)} · ${m.latencyMs}ms`;
};

const taskSummary = (t: TaskRow): string =>
  `${t.agent}@${t.agentVersion} · ${t.kind} · ${t.state}${
    t.decisionSummary ? ` — ${t.decisionSummary}` : ""
  }`;

export const observabilityRoutes = (db: Db): FastifyPluginAsync => async (app) => {
  const modelCalls = modelCallRepo(db);
  const tasks = taskRepo(db);
  const actions = actionRepo(db);

  app.get<{
    Params: { householdId: string };
    Querystring: { windowDays?: string };
  }>(
    "/households/:householdId/model-calls/daily",
    {
      config: {
        audit: {
          action: "observability.model_calls.daily",
          resourceType: "model_call",
        },
      },
    },
    async (req) => {
      const window = Number(req.query.windowDays ?? 30);
      const rows = modelCalls.dailyBreakdown(
        req.householdContext as HouseholdId,
        Number.isFinite(window) && window > 0 ? window : 30,
      );
      // Pivot rows into { day, byTier: { t1: {...}, t2: {...} } }
      // shape for easy stacked-bar rendering. Days without any
      // calls simply don't appear — the console fills gaps at
      // render time so we don't ship a big empty payload.
      const byDay = new Map<string, { day: string; totalUsd: number; totalCalls: number; byTier: Record<string, { usd: number; calls: number }> }>();
      for (const r of rows) {
        const bucket = byDay.get(r.day) ?? {
          day: r.day,
          totalUsd: 0,
          totalCalls: 0,
          byTier: {},
        };
        bucket.byTier[r.tier] = { usd: r.usd, calls: r.calls };
        bucket.totalUsd += r.usd;
        bucket.totalCalls += r.calls;
        byDay.set(r.day, bucket);
      }
      return {
        windowDays: Number.isFinite(window) && window > 0 ? window : 30,
        days: Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day)),
      };
    },
  );

  app.get<{ Params: { householdId: string; taskId: string } }>(
    "/households/:householdId/tasks/:taskId/model-calls",
    {
      config: {
        audit: {
          action: "observability.task.model_calls",
          resourceType: "model_call",
        },
      },
    },
    async (req, reply) => {
      const householdId = req.householdContext as HouseholdId;
      const task = tasks.getTask(householdId, req.params.taskId);
      if (!task) return reply.code(404).send({ error: "not_found" });
      const calls = modelCalls.listByTask(householdId, task.id);
      const totalUsd = calls.reduce((s, c) => s + c.costUsdEstimated, 0);
      const totalTokensIn = calls.reduce((s, c) => s + c.inputTokens, 0);
      const totalTokensOut = calls.reduce((s, c) => s + c.outputTokens, 0);
      const totalCached = calls.reduce(
        (s, c) => s + (c.cachedInputTokens ?? 0),
        0,
      );
      return {
        task: {
          id: task.id,
          agent: task.agent,
          kind: task.kind,
          state: task.state,
          decisionSummary: task.decisionSummary,
          createdAt: task.createdAt,
        },
        summary: {
          totalCalls: calls.length,
          totalUsd,
          totalTokensIn,
          totalTokensOut,
          totalCachedInputTokens: totalCached,
        },
        calls: calls.map((c) => ({
          id: c.id,
          createdAt: c.createdAt,
          taskClass: c.taskClass,
          minTier: c.minTier,
          selectedTier: c.selectedTier,
          modelId: c.modelId,
          provider: c.provider,
          inputTokens: c.inputTokens,
          outputTokens: c.outputTokens,
          cachedInputTokens: c.cachedInputTokens ?? 0,
          cacheWriteInputTokens: c.cacheWriteInputTokens ?? 0,
          costUsdEstimated: c.costUsdEstimated,
          latencyMs: c.latencyMs,
          finishReason: c.finishReason,
          routerReasons: c.routerReasons,
          summary: modelCallSummary(c),
        })),
      };
    },
  );

  app.get<{ Params: { householdId: string; runId: string } }>(
    "/households/:householdId/runs/:runId",
    {
      config: {
        audit: { action: "observability.run.detail", resourceType: "orchestrator_run" },
      },
    },
    async (req, reply) => {
      const householdId = req.householdContext as HouseholdId;
      const run = tasks.getRun(householdId, req.params.runId);
      if (!run) return reply.code(404).send({ error: "not_found" });
      const runTasks = tasks.listTasksForRun(run.id);
      const runModelCalls = modelCalls.listByRun(householdId, run.id);

      // Actions don't carry a run/task id today. Correlate by
      // window: any action recorded between run.createdAt and
      // (run.completedAt ?? now) is a plausible sibling. Not
      // perfectly precise but good enough to show the manager
      // "here's what fired around this run."
      const startMs = Date.parse(run.createdAt);
      const endMs = run.completedAt
        ? Date.parse(run.completedAt)
        : Date.now();
      // Small padding to catch actions that landed just after
      // finishRun stamped the run finished.
      const paddedEnd = endMs + 5_000;
      const windowActions = actions
        .list(householdId, 500)
        .filter((a) => {
          const t = Date.parse(a.createdAt);
          return t >= startMs && t <= paddedEnd;
        });

      const timeline: TimelineEvent[] = [
        {
          at: run.createdAt,
          kind: "run",
          summary: `Run started · ${run.intentKind} · origin ${run.origin}:${run.originBy}`,
          detail: {
            intentKind: run.intentKind,
            intentAttrs: run.intentAttrs,
          },
        },
        ...runTasks.map((t): TimelineEvent => ({
          at: t.createdAt,
          kind: "task",
          summary: taskSummary(t),
          detail: {
            id: t.id,
            agent: t.agent,
            kind: t.kind,
            state: t.state,
            outputs: t.outputs,
          },
        })),
        ...runModelCalls.map((c): TimelineEvent => ({
          at: c.createdAt,
          kind: "model_call",
          summary: modelCallSummary(c),
          detail: {
            id: c.id,
            taskClass: c.taskClass,
            modelId: c.modelId,
            selectedTier: c.selectedTier,
            costUsdEstimated: c.costUsdEstimated,
            routerReasons: c.routerReasons,
            triggeringTaskId: c.triggeringTaskId,
          },
        })),
        ...windowActions.map((a): TimelineEvent => ({
          at: a.createdAt,
          kind: "action",
          summary: `${a.tool}@${a.toolVersion} · ${a.actionClass} · ${a.outcome}${a.summary ? ` — ${a.summary}` : ""}`,
          detail: {
            id: a.id,
            tool: a.tool,
            actionClass: a.actionClass,
            outcome: a.outcome,
            amountUsd: a.amountUsd,
            policyIdAuthorizing: a.policyIdAuthorizing,
          },
        })),
      ];
      if (run.completedAt) {
        timeline.push({
          at: run.completedAt,
          kind: "run",
          summary: `Run finished · ${run.state}`,
        });
      }
      timeline.sort((a, b) => a.at.localeCompare(b.at));

      const totalUsd = runModelCalls.reduce((s, c) => s + c.costUsdEstimated, 0);
      return {
        run: {
          id: run.id,
          intentKind: run.intentKind,
          intentAttrs: run.intentAttrs,
          origin: run.origin,
          originBy: run.originBy,
          state: run.state,
          createdAt: run.createdAt,
          finishedAt: run.completedAt,
        },
        summary: {
          taskCount: runTasks.length,
          modelCallCount: runModelCalls.length,
          actionCount: windowActions.length,
          totalUsd,
        },
        timeline,
      };
    },
  );
};
