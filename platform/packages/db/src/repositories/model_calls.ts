import { randomBytes } from "node:crypto";
import { and, desc, eq, gte, sum, count, sql } from "drizzle-orm";
import { nowIso, type HouseholdId } from "@atelier/domain";
import type { Db } from "../client.js";
import { modelCalls, type ModelCallRow } from "../schema/model_calls.js";

const newModelCallId = (): string => `mcl_${randomBytes(12).toString("hex")}`;

export interface RecordModelCallInput {
  readonly householdId?: HouseholdId;
  readonly taskClass: string;
  readonly minTier: string;
  readonly selectedTier: string;
  readonly modelId: string;
  readonly provider: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly costUsdEstimated: number;
  readonly latencyMs: number;
  readonly finishReason: string;
  readonly routerReasons: readonly string[];
  readonly inputHash: string;
  readonly outputHash: string;
  readonly triggeringRunId?: string;
  readonly triggeringTaskId?: string;
}

export interface BudgetRollup {
  readonly windowStart: string;
  readonly totalUsd: number;
  readonly totalCalls: number;
  readonly byTier: Record<string, { calls: number; usd: number }>;
}

const daysAgoIso = (days: number): string =>
  new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

export const modelCallRepo = (db: Db) => ({
  record(input: RecordModelCallInput): { id: string } {
    const id = newModelCallId();
    db.insert(modelCalls)
      .values({
        id,
        householdId: input.householdId ?? null,
        taskClass: input.taskClass,
        minTier: input.minTier,
        selectedTier: input.selectedTier,
        modelId: input.modelId,
        provider: input.provider,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cachedInputTokens: input.cachedInputTokens ?? 0,
        cacheWriteInputTokens: input.cacheWriteInputTokens ?? 0,
        costUsdEstimated: input.costUsdEstimated,
        latencyMs: input.latencyMs,
        finishReason: input.finishReason,
        routerReasons: input.routerReasons,
        inputHash: input.inputHash,
        outputHash: input.outputHash,
        triggeringRunId: input.triggeringRunId ?? null,
        triggeringTaskId: input.triggeringTaskId ?? null,
        createdAt: nowIso(),
      })
      .run();
    return { id };
  },

  list(householdId: HouseholdId, limit = 100): ModelCallRow[] {
    return db
      .select()
      .from(modelCalls)
      .where(eq(modelCalls.householdId, householdId))
      .orderBy(desc(modelCalls.createdAt))
      .limit(limit)
      .all();
  },

  rollup(householdId: HouseholdId, windowDays = 30): BudgetRollup {
    const start = daysAgoIso(windowDays);
    const totalRow = db
      .select({
        total: sum(modelCalls.costUsdEstimated),
        n: count(),
      })
      .from(modelCalls)
      .where(
        and(
          eq(modelCalls.householdId, householdId),
          gte(modelCalls.createdAt, start),
        ),
      )
      .get();

    const perTierRows = db
      .select({
        tier: modelCalls.selectedTier,
        total: sum(modelCalls.costUsdEstimated),
        n: count(),
      })
      .from(modelCalls)
      .where(
        and(
          eq(modelCalls.householdId, householdId),
          gte(modelCalls.createdAt, start),
        ),
      )
      .groupBy(modelCalls.selectedTier)
      .all();

    const byTier: Record<string, { calls: number; usd: number }> = {};
    for (const r of perTierRows) {
      byTier[r.tier] = { calls: Number(r.n ?? 0), usd: Number(r.total ?? 0) };
    }

    return {
      windowStart: start,
      totalUsd: Number(totalRow?.total ?? 0),
      totalCalls: Number(totalRow?.n ?? 0),
      byTier,
    };
  },

  listByRun(householdId: HouseholdId, runId: string): ModelCallRow[] {
    return db
      .select()
      .from(modelCalls)
      .where(
        and(
          eq(modelCalls.householdId, householdId),
          eq(modelCalls.triggeringRunId, runId),
        ),
      )
      .orderBy(modelCalls.createdAt)
      .all();
  },

  listByTask(householdId: HouseholdId, taskId: string): ModelCallRow[] {
    return db
      .select()
      .from(modelCalls)
      .where(
        and(
          eq(modelCalls.householdId, householdId),
          eq(modelCalls.triggeringTaskId, taskId),
        ),
      )
      .orderBy(modelCalls.createdAt)
      .all();
  },

  // Daily buckets for the cost dashboard. Groups by the YYYY-MM-DD
  // prefix of createdAt (ISO 8601 sorts lexicographically), broken
  // down by tier so a stacked bar can render tier composition.
  dailyBreakdown(
    householdId: HouseholdId,
    windowDays = 30,
  ): Array<{ day: string; tier: string; usd: number; calls: number }> {
    const start = daysAgoIso(windowDays);
    const rows = db
      .select({
        day: sql<string>`substr(${modelCalls.createdAt}, 1, 10)`,
        tier: modelCalls.selectedTier,
        total: sum(modelCalls.costUsdEstimated),
        n: count(),
      })
      .from(modelCalls)
      .where(
        and(
          eq(modelCalls.householdId, householdId),
          gte(modelCalls.createdAt, start),
        ),
      )
      .groupBy(sql`substr(${modelCalls.createdAt}, 1, 10)`, modelCalls.selectedTier)
      .orderBy(sql`substr(${modelCalls.createdAt}, 1, 10)`)
      .all();
    return rows.map((r) => ({
      day: r.day,
      tier: r.tier,
      usd: Number(r.total ?? 0),
      calls: Number(r.n ?? 0),
    }));
  },

  monthlyByHousehold(): Array<{ householdId: string; totalUsd: number; calls: number }> {
    const start = daysAgoIso(30);
    const rows = db
      .select({
        householdId: modelCalls.householdId,
        total: sum(modelCalls.costUsdEstimated),
        n: count(),
      })
      .from(modelCalls)
      .where(gte(modelCalls.createdAt, start))
      .groupBy(modelCalls.householdId)
      .all();
    return rows
      .filter((r) => r.householdId !== null)
      .map((r) => ({
        householdId: r.householdId as string,
        totalUsd: Number(r.total ?? 0),
        calls: Number(r.n ?? 0),
      }));
  },

  _sql() {
    return sql;
  },
});
