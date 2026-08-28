import { createHash } from "node:crypto";
import { and, asc, eq, isNull, notInArray, sql } from "drizzle-orm";
import type { HouseholdId } from "@atelier/domain";
import type { Db } from "../client.js";
import {
  auditEventHashes,
  auditChainHeads,
  type AuditEventHashRow,
} from "../schema/audit_chain.js";
import { auditEvents, type AuditEventRow } from "../schema/audit.js";

// Chain scope key that marks the whole-household chain in
// audit_chain_heads. Anything else is treated as a principal id.
export const HOUSEHOLD_CHAIN_KEY = "household";

// Canonical JSON stringify — object keys emitted in sorted order,
// arrays preserved, no whitespace. Two events with the same
// content produce identical bytes → identical hashes, regardless
// of insertion order of keys. Non-plain values are passed through
// JSON.stringify's normal handling.
const canonicalStringify = (value: unknown): string => {
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(walk);
    const entries = Object.entries(v as Record<string, unknown>).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    );
    const out: Record<string, unknown> = {};
    for (const [k, val] of entries) out[k] = walk(val);
    return out;
  };
  return JSON.stringify(walk(value));
};

const sha256Hex = (input: string): string =>
  createHash("sha256").update(input, "utf-8").digest("hex");

interface HashPreimageInput {
  readonly event: AuditEventRow;
  readonly prevHouseholdHash: string | null;
  // Sorted ascending by principalId.
  readonly prevPersonHashes: ReadonlyArray<{
    readonly principalId: string;
    readonly hash: string | null;
  }>;
  readonly principalIds: readonly string[];
}

// The bytes that feed SHA-256 for an event's chain hash. Every
// field that could be tampered with is included; the event's own
// metadata JSON is canonicalised inside the outer canonicalise so
// key-order changes on either level don't shift the hash.
export const computeEventHash = (input: HashPreimageInput): string => {
  const preimage = {
    eventId: input.event.id,
    householdId: input.event.householdId,
    actorType: input.event.actorType,
    actorId: input.event.actorId,
    action: input.event.action,
    resourceType: input.event.resourceType,
    resourceId: input.event.resourceId,
    sensitive: input.event.sensitive,
    metadata: input.event.metadata ?? {},
    at: input.event.at,
    prevHouseholdHash: input.prevHouseholdHash,
    prevPersonHashes: [...input.prevPersonHashes].sort((a, b) =>
      a.principalId < b.principalId
        ? -1
        : a.principalId > b.principalId
          ? 1
          : 0,
    ),
    principalIds: [...input.principalIds].sort(),
  };
  return sha256Hex(canonicalStringify(preimage));
};

interface HeadRow {
  readonly headHash: string;
  readonly eventCount: number;
}

export interface HeadInfo {
  readonly headHash: string;
  readonly headEventId: string;
  readonly headAt: string;
  readonly eventCount: number;
}

export interface VerifyResult {
  readonly valid: boolean;
  readonly eventCount: number;
  readonly headHash: string | null;
  // If !valid, the first event id (in chain order) whose stored
  // hash didn't match the recomputed one. `null` on a valid chain.
  readonly brokenAtEventId?: string;
  readonly brokenReason?: string;
}

export const auditChainRepo = (db: Db) => {
  const readHead = (
    householdId: HouseholdId,
    chainKey: string,
  ): HeadRow | null => {
    const row = db
      .select({
        headHash: auditChainHeads.headHash,
        eventCount: auditChainHeads.eventCount,
      })
      .from(auditChainHeads)
      .where(
        and(
          eq(auditChainHeads.householdId, householdId),
          eq(auditChainHeads.chainKey, chainKey),
        ),
      )
      .get();
    return row ?? null;
  };

  const upsertHead = (
    householdId: HouseholdId,
    chainKey: string,
    input: HeadInfo,
  ): void => {
    const existing = readHead(householdId, chainKey);
    if (existing) {
      db.update(auditChainHeads)
        .set({
          headHash: input.headHash,
          headEventId: input.headEventId,
          headAt: input.headAt,
          eventCount: input.eventCount,
        })
        .where(
          and(
            eq(auditChainHeads.householdId, householdId),
            eq(auditChainHeads.chainKey, chainKey),
          ),
        )
        .run();
    } else {
      db.insert(auditChainHeads)
        .values({
          householdId,
          chainKey,
          headHash: input.headHash,
          headEventId: input.headEventId,
          headAt: input.headAt,
          eventCount: input.eventCount,
        })
        .run();
    }
  };

  return {
    // Append one event onto every chain it participates in. Idempotent
    // on eventId — a duplicate append is a no-op, so retries and
    // backfill can safely re-run without corrupting the chain.
    append(input: {
      event: AuditEventRow;
      principalIds: readonly string[];
    }): AuditEventHashRow {
      const existing = db
        .select()
        .from(auditEventHashes)
        .where(eq(auditEventHashes.eventId, input.event.id))
        .get();
      if (existing) return existing;

      const householdId = input.event.householdId as HouseholdId;
      const principals = Array.from(new Set(input.principalIds)).sort();

      const householdHead = readHead(householdId, HOUSEHOLD_CHAIN_KEY);
      const prevHouseholdHash = householdHead?.headHash ?? null;
      const householdSequence = (householdHead?.eventCount ?? 0) + 1;

      const prevPersonHashes = principals.map((principalId) => {
        const h = readHead(householdId, principalId);
        return { principalId, hash: h?.headHash ?? null };
      });

      const hash = computeEventHash({
        event: input.event,
        prevHouseholdHash,
        prevPersonHashes,
        principalIds: principals,
      });

      db.insert(auditEventHashes)
        .values({
          eventId: input.event.id,
          householdId,
          hash,
          prevHouseholdHash,
          prevPersonHashes,
          principalIds: principals,
          householdSequence,
        })
        .run();

      upsertHead(householdId, HOUSEHOLD_CHAIN_KEY, {
        headHash: hash,
        headEventId: input.event.id,
        headAt: input.event.at,
        eventCount: householdSequence,
      });
      for (const p of principals) {
        const priorCount = readHead(householdId, p)?.eventCount ?? 0;
        upsertHead(householdId, p, {
          headHash: hash,
          headEventId: input.event.id,
          headAt: input.event.at,
          eventCount: priorCount + 1,
        });
      }

      const row = db
        .select()
        .from(auditEventHashes)
        .where(eq(auditEventHashes.eventId, input.event.id))
        .get();
      if (!row) throw new Error("audit_event_hashes insert did not return");
      return row;
    },

    getHead(householdId: HouseholdId, chainKey: string): HeadInfo | null {
      const row = db
        .select()
        .from(auditChainHeads)
        .where(
          and(
            eq(auditChainHeads.householdId, householdId),
            eq(auditChainHeads.chainKey, chainKey),
          ),
        )
        .get();
      if (!row) return null;
      return {
        headHash: row.headHash,
        headEventId: row.headEventId,
        headAt: row.headAt,
        eventCount: row.eventCount,
      };
    },

    // Walk every audit_events row without a hash yet, in ascending
    // (at, id) order, and append each to the chain. Called on
    // server startup and safely re-runnable — the append is
    // idempotent on eventId. Returns { processed, alreadyHashed }.
    backfill(householdId?: HouseholdId): { processed: number } {
      const filters = [] as ReturnType<typeof eq>[];
      if (householdId) filters.push(eq(auditEvents.householdId, householdId));
      const alreadyHashed = db
        .select({ id: auditEventHashes.eventId })
        .from(auditEventHashes)
        .all()
        .map((r) => r.id);
      let rows: AuditEventRow[];
      if (alreadyHashed.length === 0) {
        rows = db
          .select()
          .from(auditEvents)
          .where(filters.length > 0 ? and(...filters) : undefined)
          .orderBy(asc(auditEvents.at), asc(auditEvents.id))
          .all();
      } else {
        rows = db
          .select()
          .from(auditEvents)
          .where(
            filters.length > 0
              ? and(...filters, notInArray(auditEvents.id, alreadyHashed))
              : notInArray(auditEvents.id, alreadyHashed),
          )
          .orderBy(asc(auditEvents.at), asc(auditEvents.id))
          .all();
      }
      let processed = 0;
      for (const event of rows) {
        this.append({
          event,
          principalIds: extractPrincipalIds(event),
        });
        processed++;
      }
      return { processed };
    },

    // Walk a chain from oldest to newest, re-hashing every event
    // from its stored content + stored parent hashes, and
    // verifying each hash matches the stored one AND the last
    // event's hash matches the current head. Returns { valid,
    // eventCount, headHash, brokenAtEventId? }.
    verifyHouseholdChain(householdId: HouseholdId): VerifyResult {
      const rows = db
        .select()
        .from(auditEventHashes)
        .where(eq(auditEventHashes.householdId, householdId))
        .orderBy(asc(auditEventHashes.householdSequence))
        .all();
      const head = this.getHead(householdId, HOUSEHOLD_CHAIN_KEY);
      if (rows.length === 0) {
        return { valid: true, eventCount: 0, headHash: head?.headHash ?? null };
      }
      let lastHash: string | null = null;
      for (const hashRow of rows) {
        const event = db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.id, hashRow.eventId))
          .get();
        if (!event) {
          return {
            valid: false,
            eventCount: rows.length,
            headHash: head?.headHash ?? null,
            brokenAtEventId: hashRow.eventId,
            brokenReason: "event_row_missing",
          };
        }
        const recomputed = computeEventHash({
          event,
          prevHouseholdHash: hashRow.prevHouseholdHash,
          prevPersonHashes: (hashRow.prevPersonHashes ?? []) as Array<{
            principalId: string;
            hash: string | null;
          }>,
          principalIds: (hashRow.principalIds ?? []) as string[],
        });
        if (recomputed !== hashRow.hash) {
          return {
            valid: false,
            eventCount: rows.length,
            headHash: head?.headHash ?? null,
            brokenAtEventId: hashRow.eventId,
            brokenReason: "hash_mismatch",
          };
        }
        lastHash = hashRow.hash;
      }
      if (head && head.headHash !== lastHash) {
        return {
          valid: false,
          eventCount: rows.length,
          headHash: head.headHash,
          brokenAtEventId: head.headEventId,
          brokenReason: "head_hash_diverges_from_tail",
        };
      }
      return {
        valid: true,
        eventCount: rows.length,
        headHash: head?.headHash ?? lastHash,
      };
    },

    verifyPersonChain(
      householdId: HouseholdId,
      principalId: string,
    ): VerifyResult {
      // Person chain: filter to hash rows that include this
      // principalId, walk in householdSequence order (which is
      // strictly ascending along any subchain), re-hash each,
      // check against the stored hash.
      const rows = db
        .select()
        .from(auditEventHashes)
        .where(
          and(
            eq(auditEventHashes.householdId, householdId),
            sql`json_extract(${auditEventHashes.principalIds}, '$') LIKE ${
              `%${principalId}%`
            }`,
          ),
        )
        .orderBy(asc(auditEventHashes.householdSequence))
        .all()
        .filter((r) =>
          ((r.principalIds ?? []) as string[]).includes(principalId),
        );
      const head = this.getHead(householdId, principalId);
      if (rows.length === 0) {
        return { valid: true, eventCount: 0, headHash: head?.headHash ?? null };
      }
      let lastHash: string | null = null;
      for (const hashRow of rows) {
        const event = db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.id, hashRow.eventId))
          .get();
        if (!event) {
          return {
            valid: false,
            eventCount: rows.length,
            headHash: head?.headHash ?? null,
            brokenAtEventId: hashRow.eventId,
            brokenReason: "event_row_missing",
          };
        }
        const recomputed = computeEventHash({
          event,
          prevHouseholdHash: hashRow.prevHouseholdHash,
          prevPersonHashes: (hashRow.prevPersonHashes ?? []) as Array<{
            principalId: string;
            hash: string | null;
          }>,
          principalIds: (hashRow.principalIds ?? []) as string[],
        });
        if (recomputed !== hashRow.hash) {
          return {
            valid: false,
            eventCount: rows.length,
            headHash: head?.headHash ?? null,
            brokenAtEventId: hashRow.eventId,
            brokenReason: "hash_mismatch",
          };
        }
        lastHash = hashRow.hash;
      }
      if (head && head.headHash !== lastHash) {
        return {
          valid: false,
          eventCount: rows.length,
          headHash: head.headHash,
          brokenAtEventId: head.headEventId,
          brokenReason: "head_hash_diverges_from_tail",
        };
      }
      return {
        valid: true,
        eventCount: rows.length,
        headHash: head?.headHash ?? lastHash,
      };
    },
  };
};

// Heuristic: an audit_events row identifies a principal if its
// resource_type is "principal" (resource_id is then the principal
// id), or if its metadata.route.principalIds is a string array.
// Extending this in the future is a matter of adding rules here —
// the persisted chain doesn't need to migrate.
export const extractPrincipalIds = (event: AuditEventRow): string[] => {
  const out = new Set<string>();
  if (event.resourceType === "principal" && event.resourceId) {
    out.add(event.resourceId);
  }
  const meta = event.metadata as Record<string, unknown> | null;
  const route = meta && typeof meta === "object" ? meta["route"] : null;
  if (route && typeof route === "object") {
    const pids = (route as Record<string, unknown>)["principalIds"];
    if (Array.isArray(pids)) {
      for (const p of pids) {
        if (typeof p === "string" && p) out.add(p);
      }
    }
  }
  return Array.from(out).sort();
};

// Exported for reachability from tests / debug scripts. The
// isNull import above stays exported implicitly via drizzle-orm
// re-export.
export { isNull };
