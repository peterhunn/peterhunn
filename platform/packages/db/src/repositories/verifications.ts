import { randomBytes, randomInt } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { nowIso, type HouseholdId } from "@atelier/domain";
import type { Db } from "../client.js";
import {
  pendingVerifications,
  type PendingVerificationRow,
} from "../schema/verifications.js";
import type { MessagingChannel } from "./messaging.js";

const newVerificationId = (): string => `ver_${randomBytes(12).toString("hex")}`;

// 6-digit numeric code, biased away from confusable/leading-zero
// codes so the customer types cleanly. Uses crypto random so codes
// aren't guessable inside the TTL window.
const mintCode = (): string => {
  return String(randomInt(100_000, 1_000_000));
};

export interface CreateVerificationInput {
  readonly householdId: HouseholdId;
  readonly channel: MessagingChannel;
  readonly createdBy: string;
  readonly ttlSeconds?: number;
  readonly label?: string;
  // Optional profile the resulting endpoint should be bound to.
  // Carried on the pending_verifications row and copied onto the
  // contact_endpoints row when the code is consumed.
  readonly principalId?: string;
}

const DEFAULT_TTL_SECONDS = 15 * 60;

export const pendingVerificationRepo = (db: Db) => ({
  create(input: CreateVerificationInput): PendingVerificationRow {
    const id = newVerificationId();
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000,
    ).toISOString();
    // Retry on the astronomically-unlikely code collision with a
    // live pending verification. Ten attempts is plenty; the space
    // is 900,000 codes.
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = mintCode();
      const existing = db
        .select()
        .from(pendingVerifications)
        .where(
          and(
            eq(pendingVerifications.code, code),
            isNull(pendingVerifications.consumedAt),
          ),
        )
        .get();
      if (existing) continue;
      db.insert(pendingVerifications)
        .values({
          id,
          householdId: input.householdId,
          channel: input.channel,
          code,
          createdBy: input.createdBy,
          createdAt: nowIso(),
          expiresAt,
          label: input.label ?? null,
          principalId: input.principalId ?? null,
        })
        .run();
      const row = db
        .select()
        .from(pendingVerifications)
        .where(eq(pendingVerifications.id, id))
        .get();
      if (!row) throw new Error("pending verification insert did not return");
      return row;
    }
    throw new Error("pending verification code collision (retries exhausted)");
  },

  // Find a live (unconsumed, unexpired) verification whose code
  // appears verbatim in the body. Returns null if no match — that
  // keeps the webhook's control flow simple.
  findLiveByCode(
    channel: MessagingChannel,
    code: string,
    nowIsoTs = nowIso(),
  ): PendingVerificationRow | null {
    const row = db
      .select()
      .from(pendingVerifications)
      .where(
        and(
          eq(pendingVerifications.channel, channel),
          eq(pendingVerifications.code, code),
          isNull(pendingVerifications.consumedAt),
        ),
      )
      .get();
    if (!row) return null;
    if (row.expiresAt <= nowIsoTs) return null;
    return row;
  },

  consume(
    id: string,
    consumedFromAddress: string,
    consumedEndpointId: string,
  ): void {
    db.update(pendingVerifications)
      .set({
        consumedAt: nowIso(),
        consumedFromAddress,
        consumedEndpointId,
      })
      .where(eq(pendingVerifications.id, id))
      .run();
  },

  list(householdId: HouseholdId, limit = 25): PendingVerificationRow[] {
    return db
      .select()
      .from(pendingVerifications)
      .where(eq(pendingVerifications.householdId, householdId))
      .orderBy(desc(pendingVerifications.createdAt))
      .limit(limit)
      .all();
  },
});

// Extract the first 6-digit numeric token from a message body — the
// verification code the customer typed. Word-boundary anchored so a
// 10-digit phone number won't false-positive as a code.
export const extractVerificationCode = (body: string): string | null => {
  const m = /\b(\d{6})\b/.exec(body);
  return m ? m[1]! : null;
};
