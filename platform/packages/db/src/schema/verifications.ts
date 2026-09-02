import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { households } from "./households.js";

// A pending verification code lets an unrouted inbound message bind
// its from-address to a household. Manager mints a code; customer
// texts the code from the number to verify; the webhook detects the
// code in the body, creates the contact endpoint, marks consumed.
// TTL is short (default 15 min) so codes don't become long-lived
// secrets. One-shot: consumedAt goes non-null on first successful
// claim; further attempts with the same code are rejected.
export const pendingVerifications = sqliteTable(
  "pending_verifications",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    channel: text("channel", { enum: ["sms", "whatsapp", "imessage", "email"] })
      .notNull(),
    code: text("code").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    consumedAt: text("consumed_at"),
    consumedFromAddress: text("consumed_from_address"),
    consumedEndpointId: text("consumed_endpoint_id"),
    label: text("label"),
    // Optional profile the resulting endpoint should be bound to.
    // A person.principal / .member / .staff / .contact node id from
    // the same household. When set, the endpoint created on
    // successful verification inherits this principal_id and every
    // inbound message from that number identifies the sender as
    // this person to the planner.
    principalId: text("principal_id"),
  },
  (t) => ({
    codeIdx: index("pending_verifications_code_idx").on(t.code),
    householdIdx: index("pending_verifications_household_idx").on(t.householdId),
  }),
);

export type PendingVerificationRow = typeof pendingVerifications.$inferSelect;
