import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { households } from "./households.js";

// Inbox messages are stored here, NOT in the Life Graph. Per
// docs/22-knowledge-graph.md §"What is NOT stored in the
// graph": raw email bodies do not enter the graph. Structured facts
// extracted from a message land in the graph as candidates; pointers
// back to the message live via the message id in an extracted node's
// sourceRef.
//
// Despite the name, this table holds email in BOTH directions. The
// `direction` column was added when we started syncing the SENT
// label to fill in the outbound half of a customer's timeline; the
// table's kept its name to avoid renaming through every downstream.
export const inboxMessages = sqliteTable(
  "inbox_messages",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),

    fromName: text("from_name").notNull(),
    fromAddress: text("from_address").notNull(),
    // Outbound-only. Inbound rows leave this null — the recipient
    // there is the household's own Gmail account, not a fact the
    // manager needs to see on every row.
    toAddress: text("to_address"),
    // Which way the mail is flowing relative to the household. Legacy
    // rows written before this column existed default to 'inbound'.
    direction: text("direction", { enum: ["inbound", "outbound"] })
      .notNull()
      .default("inbound"),
    recipientPrincipalId: text("recipient_principal_id"),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    receivedAt: text("received_at").notNull(),

    externalProvider: text("external_provider"),
    externalMessageId: text("external_message_id"),
    externalThreadId: text("external_thread_id"),
    // RFC 5322 Message-ID header, angle brackets stripped. Distinct
    // from externalMessageId (which is Gmail's internal opaque id):
    // this is the id that actually goes on the wire and is what
    // non-Gmail MUAs use to thread. Populated by the Gmail sync
    // when it can read the header; used by outbound sends as the
    // In-Reply-To / References target so replies thread even for
    // recipients not on Gmail.
    messageIdHeader: text("message_id_header"),

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
    externalIdIdx: index("inbox_external_id_idx").on(
      t.externalProvider,
      t.externalMessageId,
    ),
  }),
);

export type InboxMessageRow = typeof inboxMessages.$inferSelect;
export type NewInboxMessageRow = typeof inboxMessages.$inferInsert;
