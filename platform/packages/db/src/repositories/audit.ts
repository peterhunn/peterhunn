import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, or } from "drizzle-orm";
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

  // Streaming read for the audit exporter.
  // Returns rows strictly after the cursor (at, id) in insert
  // order — (at ASC, id ASC) — so the exporter can advance a
  // (at, id) cursor without missing or double-sending an event
  // that shares a timestamp with the cursor's tail. `at` is
  // nowIso() precision (ms) so ties happen; the id secondary
  // sort resolves them deterministically.
  //
  // When cursor is null (first-ever run) every event qualifies.
  listAfter(
    cursor: { lastExportedAt: string | null; lastExportedEventId: string | null },
    limit: number,
  ): AuditEventRow[] {
    const q = db.select().from(auditEvents);
    if (cursor.lastExportedAt !== null && cursor.lastExportedEventId !== null) {
      return q
        .where(
          or(
            gt(auditEvents.at, cursor.lastExportedAt),
            and(
              eq(auditEvents.at, cursor.lastExportedAt),
              gt(auditEvents.id, cursor.lastExportedEventId),
            ),
          ),
        )
        .orderBy(asc(auditEvents.at), asc(auditEvents.id))
        .limit(limit)
        .all();
    }
    return q
      .orderBy(asc(auditEvents.at), asc(auditEvents.id))
      .limit(limit)
      .all();
  },
});
