import { and, eq, gte, inArray, sum, count, sql } from "drizzle-orm";
import {
  newActionId,
  nowIso,
  type ActionOutcome,
  type ActionId,
  type HouseholdId,
  type PolicyId,
  type Domain,
} from "@atelier/domain";
import type { Db } from "../client.js";
import { actions, type ActionRow } from "../schema/actions.js";

export interface RecordActionInput {
  readonly householdId: HouseholdId;
  readonly subjectPrincipalId?: string;
  readonly agent: string;
  readonly agentVersion: string;
  readonly tool: string;
  readonly toolVersion: string;
  readonly actionClass: string;
  readonly domain: Domain;
  readonly inputsHash: string;
  readonly outputsHash?: string;
  readonly amountUsd?: number;
  readonly policyIdAuthorizing?: PolicyId;
  readonly approverId?: string;
  readonly approvalChannel?: string;
  readonly outcome: ActionOutcome;
  readonly summary: string;
}

export interface CompleteActionInput {
  readonly outcome: ActionOutcome;
  readonly outputsHash?: string;
}

export interface RollupRange {
  readonly start: string;
  readonly end: string;
}

// Outcomes that count against a rolling-limit window. Failed and
// rolled-back actions do not consume budget.
const CHARGEABLE: ActionOutcome[] = ["planned", "in_flight", "succeeded"];

export const actionRepo = (db: Db) => ({
  record(input: RecordActionInput): ActionRow {
    const id = newActionId();
    const now = nowIso();
    db.insert(actions)
      .values({
        id,
        householdId: input.householdId,
        subjectPrincipalId: input.subjectPrincipalId ?? null,
        agent: input.agent,
        agentVersion: input.agentVersion,
        tool: input.tool,
        toolVersion: input.toolVersion,
        actionClass: input.actionClass,
        domain: input.domain,
        inputsHash: input.inputsHash,
        outputsHash: input.outputsHash ?? null,
        amountUsd: input.amountUsd ?? null,
        policyIdAuthorizing: input.policyIdAuthorizing ?? null,
        approverId: input.approverId ?? null,
        approvalChannel: input.approvalChannel ?? null,
        outcome: input.outcome,
        summary: input.summary,
        createdAt: now,
        completedAt: input.outcome === "planned" || input.outcome === "in_flight" ? null : now,
      })
      .run();
    const row = db.select().from(actions).where(eq(actions.id, id)).get();
    if (!row) throw new Error("action insert did not return");
    return row;
  },

  complete(id: ActionId, input: CompleteActionInput): void {
    db.update(actions)
      .set({
        outcome: input.outcome,
        outputsHash: input.outputsHash ?? null,
        completedAt: nowIso(),
      })
      .where(eq(actions.id, id))
      .run();
  },

  list(householdId: HouseholdId, limit = 100): ActionRow[] {
    return db
      .select()
      .from(actions)
      .where(eq(actions.householdId, householdId))
      .orderBy(sql`${actions.createdAt} DESC`)
      .limit(limit)
      .all();
  },

  amountRollup(
    householdId: HouseholdId,
    actionClass: string,
    range: RollupRange,
  ): number {
    const row = db
      .select({ total: sum(actions.amountUsd) })
      .from(actions)
      .where(
        and(
          eq(actions.householdId, householdId),
          eq(actions.actionClass, actionClass),
          gte(actions.createdAt, range.start),
          inArray(actions.outcome, CHARGEABLE),
        ),
      )
      .get();
    return Number(row?.total ?? 0);
  },

  countRollup(
    householdId: HouseholdId,
    actionClass: string,
    range: RollupRange,
  ): number {
    const row = db
      .select({ n: count() })
      .from(actions)
      .where(
        and(
          eq(actions.householdId, householdId),
          eq(actions.actionClass, actionClass),
          gte(actions.createdAt, range.start),
          inArray(actions.outcome, CHARGEABLE),
        ),
      )
      .get();
    return Number(row?.n ?? 0);
  },
});
