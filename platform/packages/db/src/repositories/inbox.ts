import { randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { nowIso, type HouseholdId } from "@atelier/domain";
import type { Db } from "../client.js";
import { inboxMessages, type InboxMessageRow } from "../schema/inbox.js";

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
});
