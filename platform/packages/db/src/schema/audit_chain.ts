import {
  sqliteTable,
  text,
  integer,
  index,
  primaryKey,
} from "drizzle-orm/sqlite-core";
import { households } from "./households.js";
import { auditEvents } from "./audit.js";

// Cryptographic Merkle-DAG chain over the audit log.
//
// Each `audit_events` row gets one `audit_event_hashes` row that
// records:
//   * `hash` — SHA-256 over the event's canonical JSON PLUS the
//     hashes of every parent (household head + one head per
//     principal the event references). Any byte change in an
//     event's content re-hashes it, breaking every descendant on
//     every chain it participates in.
//   * `prev_household_hash` — the household chain head before this
//     event was appended. `null` marks the household chain's
//     genesis.
//   * `prev_person_hashes` — JSON array of { principalId, hash }
//     for every person this event feeds into. A person's chain
//     is discovered by walking backward from the person's head
//     through `prev_person_hashes[principalId === P]`.
//   * `principal_ids` — denormalised person set, so a walker can
//     enumerate which principals this event participates in
//     without parsing the hashes structure.
//
// See docs/52-observability.md §"Audit chain (Merkle DAG)" for
// the hash canonicalisation contract, verification, and the
// external anchoring plan.
export const auditEventHashes = sqliteTable(
  "audit_event_hashes",
  {
    eventId: text("event_id")
      .primaryKey()
      .references(() => auditEvents.id, { onDelete: "cascade" }),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    hash: text("hash").notNull(),
    // Parent on the household chain. null == genesis for this household.
    prevHouseholdHash: text("prev_household_hash"),
    // JSON array of { principalId, hash } — parents on the person
    // chains this event participates in. Sorted by principalId in
    // the canonical hash preimage so ordering is deterministic.
    prevPersonHashes: text("prev_person_hashes", { mode: "json" })
      .notNull()
      .default("[]"),
    // Principals this event participates in (denormalised for
    // fast per-person walk). Sorted ascending.
    principalIds: text("principal_ids", { mode: "json" })
      .notNull()
      .default("[]"),
    // Monotonic ordinal within the household chain — makes
    // deterministic walking possible without ordering ties on
    // the audit_events.at column (ms precision → real collisions).
    householdSequence: integer("household_sequence").notNull(),
  },
  (t) => ({
    householdSeqIdx: index("audit_hash_household_seq_idx").on(
      t.householdId,
      t.householdSequence,
    ),
    hashIdx: index("audit_hash_hash_idx").on(t.hash),
  }),
);

// Fast lookup of the current chain head per (household, chain).
// `chainKey` is either the literal string 'household' (the
// whole-household chain) or a principal id (that person's chain).
// One row per active chain; deleted implicitly with the household.
export const auditChainHeads = sqliteTable(
  "audit_chain_heads",
  {
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    chainKey: text("chain_key").notNull(),
    headHash: text("head_hash").notNull(),
    headEventId: text("head_event_id").notNull(),
    headAt: text("head_at").notNull(),
    eventCount: integer("event_count").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.householdId, t.chainKey] }),
  }),
);

export type AuditEventHashRow = typeof auditEventHashes.$inferSelect;
export type NewAuditEventHashRow = typeof auditEventHashes.$inferInsert;
export type AuditChainHeadRow = typeof auditChainHeads.$inferSelect;
export type NewAuditChainHeadRow = typeof auditChainHeads.$inferInsert;
