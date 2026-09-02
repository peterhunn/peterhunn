import { and, eq } from "drizzle-orm";
import { nowIso, type HouseholdId } from "@atelier/domain";
import type { Db } from "../client.js";
import { syncState } from "../schema/sync_state.js";

export const syncStateRepo = (db: Db) => ({
  get(householdId: HouseholdId, provider: string): {
    cursor: unknown;
    updatedAt: string;
    lastResult: unknown;
  } | null {
    const row = db
      .select()
      .from(syncState)
      .where(and(eq(syncState.householdId, householdId), eq(syncState.provider, provider)))
      .get();
    if (!row) return null;
    return {
      cursor: row.cursor,
      updatedAt: row.updatedAt,
      lastResult: row.lastResult ?? null,
    };
  },

  save(
    householdId: HouseholdId,
    provider: string,
    cursor: unknown,
    lastResult?: unknown,
  ): void {
    const now = nowIso();
    const existing = db
      .select()
      .from(syncState)
      .where(and(eq(syncState.householdId, householdId), eq(syncState.provider, provider)))
      .get();
    if (existing) {
      db.update(syncState)
        .set({
          cursor,
          updatedAt: now,
          lastResult: lastResult ?? existing.lastResult ?? null,
        })
        .where(
          and(eq(syncState.householdId, householdId), eq(syncState.provider, provider)),
        )
        .run();
    } else {
      db.insert(syncState)
        .values({
          householdId,
          provider,
          cursor,
          updatedAt: now,
          lastResult: lastResult ?? null,
        })
        .run();
    }
  },

  clear(householdId: HouseholdId, provider: string): void {
    db.delete(syncState)
      .where(and(eq(syncState.householdId, householdId), eq(syncState.provider, provider)))
      .run();
  },

  list(householdId: HouseholdId): Array<{
    provider: string;
    cursor: unknown;
    updatedAt: string;
    lastResult: unknown;
  }> {
    return db
      .select()
      .from(syncState)
      .where(eq(syncState.householdId, householdId))
      .all()
      .map((r) => ({
        provider: r.provider,
        cursor: r.cursor,
        updatedAt: r.updatedAt,
        lastResult: r.lastResult ?? null,
      }));
  },
});
