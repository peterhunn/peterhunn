import { randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  nowIso,
  type Actor,
  type HouseholdId,
} from "@atelier/domain";
import type { Db } from "../client.js";
import { auditEvents, type AuditEventRow } from "../schema/audit.js";

export interface RecordAuditInput {
  readonly householdId: HouseholdId;
  readonly actor: Actor;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly sensitive?: boolean;
  readonly metadata?: Record<string, unknown>;
}

const newAuditId = (): string => `aud_${randomBytes(12).toString("hex")}`;

export const auditRepo = (db: Db) => ({
  record(input: RecordAuditInput): void {
    db.insert(auditEvents)
      .values({
        id: newAuditId(),
        householdId: input.householdId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        sensitive: input.sensitive ? "yes" : "no",
        metadata: input.metadata ?? {},
        at: nowIso(),
      })
      .run();
  },

  listForHousehold(householdId: HouseholdId, limit = 100): AuditEventRow[] {
    return db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.householdId, householdId))
      .orderBy(desc(auditEvents.at))
      .limit(limit)
      .all();
  },

  listForResource(
    resourceType: string,
    resourceId: string,
    limit = 50,
  ): AuditEventRow[] {
    return db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.resourceType, resourceType),
          eq(auditEvents.resourceId, resourceId),
        ),
      )
      .orderBy(desc(auditEvents.at))
      .limit(limit)
      .all();
  },
});
