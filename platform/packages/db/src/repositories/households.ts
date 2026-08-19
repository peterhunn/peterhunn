import { and, eq, isNull } from "drizzle-orm";
import {
  newHouseholdId,
  nowIso,
  type Household,
  type HouseholdId,
  type HouseholdTier,
  type HouseholdRiskTier,
} from "@atelier/domain";
import type { Db } from "../client.js";
import { households } from "../schema/households.js";

export interface CreateHouseholdInput {
  readonly name: string;
  readonly tier: HouseholdTier;
  readonly riskTier?: HouseholdRiskTier;
}

export interface HouseholdState extends Household {
  readonly frozenAt: string | undefined;
  readonly frozenReason: string | undefined;
  readonly autopilotEnabled: boolean;
}

const toHousehold = (row: typeof households.$inferSelect): HouseholdState => ({
  id: row.id as HouseholdId,
  name: row.name,
  tier: row.tier,
  riskTier: row.riskTier,
  createdAt: row.createdAt,
  frozenAt: row.frozenAt ?? undefined,
  frozenReason: row.frozenReason ?? undefined,
  autopilotEnabled: row.autopilotEnabled !== "no",
});

export const householdRepo = (db: Db) => ({
  create(input: CreateHouseholdInput): HouseholdState {
    const row = {
      id: newHouseholdId(),
      name: input.name,
      tier: input.tier,
      riskTier: input.riskTier ?? "standard",
      createdAt: nowIso(),
    } satisfies typeof households.$inferInsert;
    db.insert(households).values(row).run();
    return toHousehold({
      ...row,
      archivedAt: null,
      frozenAt: null,
      frozenReason: null,
      autopilotEnabled: "yes",
    });
  },

  setAutopilot(id: HouseholdId, enabled: boolean): void {
    db.update(households)
      .set({ autopilotEnabled: enabled ? "yes" : "no" })
      .where(eq(households.id, id))
      .run();
  },

  get(id: HouseholdId): HouseholdState | null {
    const row = db
      .select()
      .from(households)
      .where(and(eq(households.id, id), isNull(households.archivedAt)))
      .get();
    return row ? toHousehold(row) : null;
  },

  list(): HouseholdState[] {
    const rows = db
      .select()
      .from(households)
      .where(isNull(households.archivedAt))
      .all();
    return rows.map(toHousehold);
  },

  freeze(id: HouseholdId, reason: string): void {
    db.update(households)
      .set({ frozenAt: nowIso(), frozenReason: reason })
      .where(eq(households.id, id))
      .run();
  },

  unfreeze(id: HouseholdId): void {
    db.update(households)
      .set({ frozenAt: null, frozenReason: null })
      .where(eq(households.id, id))
      .run();
  },

  archive(id: HouseholdId): void {
    db.update(households)
      .set({ archivedAt: nowIso() })
      .where(eq(households.id, id))
      .run();
  },
});
