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

const toHousehold = (row: typeof households.$inferSelect): Household => ({
  id: row.id as HouseholdId,
  name: row.name,
  tier: row.tier,
  riskTier: row.riskTier,
  createdAt: row.createdAt,
});

export const householdRepo = (db: Db) => ({
  create(input: CreateHouseholdInput): Household {
    const row = {
      id: newHouseholdId(),
      name: input.name,
      tier: input.tier,
      riskTier: input.riskTier ?? "standard",
      createdAt: nowIso(),
    } satisfies typeof households.$inferInsert;
    db.insert(households).values(row).run();
    return toHousehold(row);
  },

  get(id: HouseholdId): Household | null {
    const row = db
      .select()
      .from(households)
      .where(and(eq(households.id, id), isNull(households.archivedAt)))
      .get();
    return row ? toHousehold(row) : null;
  },

  list(): Household[] {
    const rows = db
      .select()
      .from(households)
      .where(isNull(households.archivedAt))
      .all();
    return rows.map(toHousehold);
  },

  archive(id: HouseholdId): void {
    db.update(households)
      .set({ archivedAt: nowIso() })
      .where(eq(households.id, id))
      .run();
  },
});
