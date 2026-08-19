import { sqliteTable, text, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { households } from "./households.js";

// Contact endpoints let a customer reach the platform through a
// non-email channel (SMS, WhatsApp, iMessage). One row per address.
// A message arriving on that address is resolved back to a household
// via the (channel, address) unique index. Revocation is soft so we
// keep the audit trail of who ever routed here.
export const contactEndpoints = sqliteTable(
  "contact_endpoints",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    channel: text("channel", { enum: ["sms", "whatsapp", "imessage", "email"] })
      .notNull(),
    address: text("address").notNull(),
    principalId: text("principal_id"),
    label: text("label"),
    verifiedAt: text("verified_at"),
    createdAt: text("created_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (t) => ({
    householdIdx: index("contact_endpoints_household_idx").on(t.householdId),
    channelAddrIdx: uniqueIndex("contact_endpoints_channel_address_uidx").on(
      t.channel,
      t.address,
    ),
  }),
);

// A single messaging event on a channel — inbound webhook or an
// outbound reply we sent. Includes the raw provider id for dedupe
// so a retried Twilio webhook doesn't fire the planner twice, and
// carries a pointer to the orchestrator run it triggered (or was
// triggered by).
export const messagingEvents = sqliteTable(
  "messaging_events",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    endpointId: text("endpoint_id"),
    direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
    channel: text("channel", { enum: ["sms", "whatsapp", "imessage", "email"] })
      .notNull(),
    provider: text("provider").notNull(),
    externalMessageId: text("external_message_id"),
    fromAddress: text("from_address").notNull(),
    toAddress: text("to_address").notNull(),
    body: text("body").notNull(),
    receivedAt: text("received_at").notNull(),
    plannerRunId: text("planner_run_id"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    householdIdx: index("messaging_events_household_idx").on(t.householdId),
    externalIdx: uniqueIndex("messaging_events_external_uidx").on(
      t.provider,
      t.externalMessageId,
    ),
    receivedAtIdx: index("messaging_events_received_at_idx").on(
      t.householdId,
      t.receivedAt,
    ),
  }),
);

export type ContactEndpointRow = typeof contactEndpoints.$inferSelect;
export type MessagingEventRow = typeof messagingEvents.$inferSelect;
