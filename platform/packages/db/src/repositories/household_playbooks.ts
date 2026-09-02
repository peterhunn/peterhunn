import { and, eq, lte } from "drizzle-orm";
import { nowIso, type HouseholdId } from "@atelier/domain";
import type { Db } from "../client.js";
import {
  householdPlaybooks,
  type HouseholdPlaybookRow,
} from "../schema/household_playbooks.js";

export interface EnableHouseholdPlaybookInput {
  readonly householdId: HouseholdId;
  readonly playbookId: string;
  readonly config: Record<string, unknown>;
  readonly nextFireAt: string;
}

export const householdPlaybookRepo = (db: Db) => ({
  list(householdId: HouseholdId): HouseholdPlaybookRow[] {
    return db
      .select()
      .from(householdPlaybooks)
      .where(eq(householdPlaybooks.householdId, householdId))
      .all();
  },

  get(householdId: HouseholdId, playbookId: string): HouseholdPlaybookRow | null {
    return (
      db
        .select()
        .from(householdPlaybooks)
        .where(
          and(
            eq(householdPlaybooks.householdId, householdId),
            eq(householdPlaybooks.playbookId, playbookId),
          ),
        )
        .get() ?? null
    );
  },

  // Enable-or-update. Called both on first opt-in and when a manager
  // adjusts config. Preserves lastFireAt if the row already exists
  // so a config tweak doesn't force an immediate re-fire.
  upsert(input: EnableHouseholdPlaybookInput): HouseholdPlaybookRow {
    const existing = this.get(input.householdId, input.playbookId);
    const now = nowIso();
    if (existing) {
      db.update(householdPlaybooks)
        .set({
          enabled: "yes",
          config: input.config,
          nextFireAt: input.nextFireAt,
          updatedAt: now,
        })
        .where(
          and(
            eq(householdPlaybooks.householdId, input.householdId),
            eq(householdPlaybooks.playbookId, input.playbookId),
          ),
        )
        .run();
    } else {
      db.insert(householdPlaybooks)
        .values({
          householdId: input.householdId,
          playbookId: input.playbookId,
          enabled: "yes",
          config: input.config,
          nextFireAt: input.nextFireAt,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
    const row = this.get(input.householdId, input.playbookId);
    if (!row) throw new Error("household playbook upsert did not return");
    return row;
  },

  setEnabled(
    householdId: HouseholdId,
    playbookId: string,
    enabled: boolean,
  ): void {
    db.update(householdPlaybooks)
      .set({ enabled: enabled ? "yes" : "no", updatedAt: nowIso() })
      .where(
        and(
          eq(householdPlaybooks.householdId, householdId),
          eq(householdPlaybooks.playbookId, playbookId),
        ),
      )
      .run();
  },

  // Record a firing: stamp lastFireAt=now, nextFireAt=whatever the
  // caller computed, lastRunId if the orchestrator returned one.
  recordFire(input: {
    householdId: HouseholdId;
    playbookId: string;
    nextFireAt: string;
    lastRunId?: string;
  }): void {
    db.update(householdPlaybooks)
      .set({
        lastFireAt: nowIso(),
        nextFireAt: input.nextFireAt,
        lastRunId: input.lastRunId ?? null,
        updatedAt: nowIso(),
      })
      .where(
        and(
          eq(householdPlaybooks.householdId, input.householdId),
          eq(householdPlaybooks.playbookId, input.playbookId),
        ),
      )
      .run();
  },

  // Scheduler walks these on every tick — enabled AND due.
  listDue(nowIsoTs = nowIso()): HouseholdPlaybookRow[] {
    return db
      .select()
      .from(householdPlaybooks)
      .where(
        and(
          eq(householdPlaybooks.enabled, "yes"),
          lte(householdPlaybooks.nextFireAt, nowIsoTs),
        ),
      )
      .all();
  },
});
