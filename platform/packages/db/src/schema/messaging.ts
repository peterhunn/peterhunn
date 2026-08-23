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
    // Consent tracking for TCPA-style compliance. status is one of:
    //   unknown    — no explicit signal yet (default for manager-
    //                direct adds; outbound is technically allowed
    //                but the operator carries the compliance risk)
    //   opted_in   — the customer took an explicit action (typed
    //                the invite code, texted in first, replied
    //                START after opting out)
    //   opted_out  — the customer texted STOP / UNSUBSCRIBE / etc.
    //                — outbound is BLOCKED regardless of source
    // source records which action produced the current status so
    // an audit later can reconstruct the chain.
    consentStatus: text("consent_status", {
      enum: ["unknown", "opted_in", "opted_out"],
    })
      .notNull()
      .default("unknown"),
    consentRecordedAt: text("consent_recorded_at"),
    consentSource: text("consent_source"),
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
    // Groups this event into a rolling conversation with the same
    // endpoint. Nullable so events unrelated to a conversation (a
    // STOP, an unrouted probe, a legacy row) don't need one.
    sessionId: text("session_id"),
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
    sessionIdx: index("messaging_events_session_idx").on(t.sessionId),
  }),
);

// A rolling conversation with one endpoint. Opened on the first
// inbound after the idle window, closed by idle timeout or an
// explicit end. Every event that lands during an open session
// carries its id — that's what the planner reads back as prior
// turns. The window heuristic lives in the repo (30 min today);
// this table just persists the boundary decisions.
export const conversationSessions = sqliteTable(
  "conversation_sessions",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    endpointId: text("endpoint_id").notNull(),
    principalId: text("principal_id"),
    startedAt: text("started_at").notNull(),
    lastActivityAt: text("last_activity_at").notNull(),
    closedAt: text("closed_at"),
    topic: text("topic"),
  },
  (t) => ({
    householdIdx: index("conversation_sessions_household_idx").on(t.householdId),
    endpointOpenIdx: index("conversation_sessions_endpoint_open_idx").on(
      t.endpointId,
      t.closedAt,
    ),
  }),
);

export type ContactEndpointRow = typeof contactEndpoints.$inferSelect;
export type MessagingEventRow = typeof messagingEvents.$inferSelect;
export type ConversationSessionRow = typeof conversationSessions.$inferSelect;
