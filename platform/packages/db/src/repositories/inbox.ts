import { randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { nowIso, type HouseholdId } from "@atelier/domain";
import type { Db } from "../client.js";
import { inboxMessages, type InboxMessageRow } from "../schema/inbox.js";

export interface UpsertExternalInboxInput {
  readonly householdId: HouseholdId;
  readonly externalProvider: "gmail";
  readonly externalMessageId: string;
  readonly externalThreadId?: string;
  readonly fromName: string;
  readonly fromAddress: string;
  readonly subject: string;
  readonly body: string;
  readonly receivedAt: string;
}

const newMessageId = (): string => `msg_${randomBytes(12).toString("hex")}`;

export interface CreateInboxMessageInput {
  readonly householdId: HouseholdId;
  readonly fromName: string;
  readonly fromAddress: string;
  readonly recipientPrincipalId?: string;
  readonly subject: string;
  readonly body: string;
  readonly receivedAt?: string;
}

export interface UpdateTriageInput {
  readonly urgency: string;
  readonly recipientClass: string;
  readonly requiresReply: "yes" | "no" | "unknown";
  readonly triageNotes?: string;
}

export const inboxRepo = (db: Db) => ({
  create(input: CreateInboxMessageInput): InboxMessageRow {
    const id = newMessageId();
    const now = nowIso();
    db.insert(inboxMessages)
      .values({
        id,
        householdId: input.householdId,
        fromName: input.fromName,
        fromAddress: input.fromAddress,
        recipientPrincipalId: input.recipientPrincipalId ?? null,
        subject: input.subject,
        body: input.body,
        receivedAt: input.receivedAt ?? now,
        status: "received",
        createdAt: now,
      })
      .run();
    const row = db.select().from(inboxMessages).where(eq(inboxMessages.id, id)).get();
    if (!row) throw new Error("inbox insert did not return");
    return row;
  },

  get(id: string): InboxMessageRow | null {
    return db.select().from(inboxMessages).where(eq(inboxMessages.id, id)).get() ?? null;
  },

  list(householdId: HouseholdId, limit = 50): InboxMessageRow[] {
    return db
      .select()
      .from(inboxMessages)
      .where(eq(inboxMessages.householdId, householdId))
      .orderBy(desc(inboxMessages.receivedAt))
      .limit(limit)
      .all();
  },

  updateTriage(id: string, input: UpdateTriageInput): void {
    db.update(inboxMessages)
      .set({
        status: "triaged",
        urgency: input.urgency,
        recipientClass: input.recipientClass,
        requiresReply: input.requiresReply,
        triageNotes: input.triageNotes ?? null,
        triagedAt: nowIso(),
      })
      .where(eq(inboxMessages.id, id))
      .run();
  },

  updateDraft(id: string, draftReply: string): void {
    db.update(inboxMessages)
      .set({ draftReply, draftedAt: nowIso() })
      .where(eq(inboxMessages.id, id))
      .run();
  },

  markReplied(id: string): void {
    db.update(inboxMessages)
      .set({ status: "replied" })
      .where(and(eq(inboxMessages.id, id)))
      .run();
  },

  // Upsert-by-external-id: inserts the message the first time we see
  // it, returns { inserted: false } if the (provider, externalMessageId)
  // pair already exists. Enables idempotent syncs from Gmail / any
  // other provider without duplicating rows on repeated pulls.
  upsertExternal(input: UpsertExternalInboxInput): {
    inserted: boolean;
    row: InboxMessageRow;
  } {
    const existing = db
      .select()
      .from(inboxMessages)
      .where(
        and(
          eq(inboxMessages.householdId, input.householdId),
          eq(inboxMessages.externalProvider, input.externalProvider),
          eq(inboxMessages.externalMessageId, input.externalMessageId),
        ),
      )
      .get();
    if (existing) return { inserted: false, row: existing };

    const id = newMessageId();
    const now = nowIso();
    db.insert(inboxMessages)
      .values({
        id,
        householdId: input.householdId,
        fromName: input.fromName,
        fromAddress: input.fromAddress,
        recipientPrincipalId: null,
        subject: input.subject,
        body: input.body,
        receivedAt: input.receivedAt,
        status: "received",
        externalProvider: input.externalProvider,
        externalMessageId: input.externalMessageId,
        externalThreadId: input.externalThreadId ?? null,
        createdAt: now,
      })
      .run();
    const row = db.select().from(inboxMessages).where(eq(inboxMessages.id, id)).get();
    if (!row) throw new Error("inbox upsert did not return");
    return { inserted: true, row };
  },
});
