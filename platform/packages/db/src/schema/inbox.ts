import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { households } from "./households.js";

// Inbox messages are stored here, NOT in the Life Graph. Per
// ../life-management/knowledge-graph.md §"What is NOT stored in the
// graph": raw email bodies do not enter the graph. Structured facts
// extracted from a message land in the graph as candidates; pointers
// back to the message live via the message id in an extracted node's
// sourceRef.
export const inboxMessages = sqliteTable(
  "inbox_messages",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),

    fromName: text("from_name").notNull(),
    fromAddress: text("from_address").notNull(),
    recipientPrincipalId: text("recipient_principal_id"),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    receivedAt: text("received_at").notNull(),

    status: text("status", {
      enum: ["received", "triaged", "replied", "archived", "spam"],
    })
      .notNull()
      .default("received"),

    urgency: text("urgency"),
    recipientClass: text("recipient_class"),
    requiresReply: text("requires_reply", { enum: ["yes", "no", "unknown"] })
      .notNull()
      .default("unknown"),
    triageNotes: text("triage_notes"),
    triagedAt: text("triaged_at"),

    draftReply: text("draft_reply"),
    draftedAt: text("drafted_at"),

    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    householdStatusIdx: index("inbox_household_status_idx").on(t.householdId, t.status),
    householdReceivedAtIdx: index("inbox_household_received_at_idx").on(
      t.householdId,
      t.receivedAt,
    ),
  }),
);

export type InboxMessageRow = typeof inboxMessages.$inferSelect;
export type NewInboxMessageRow = typeof inboxMessages.$inferInsert;
