import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, isNull } from "drizzle-orm";
import { nowIso, type HouseholdId } from "@atelier/domain";
import type { Db } from "../client.js";
import {
  contactEndpoints,
  conversationSessions,
  messagingEvents,
  type ContactEndpointRow,
  type ConversationSessionRow,
  type MessagingEventRow,
} from "../schema/messaging.js";

export type MessagingChannel = "sms" | "whatsapp" | "imessage" | "email";

export interface CreateContactEndpointInput {
  readonly householdId: HouseholdId;
  readonly channel: MessagingChannel;
  readonly address: string;
  readonly principalId?: string;
  readonly label?: string;
}

const newEndpointId = (): string => `ep_${randomBytes(12).toString("hex")}`;
const newEventId = (): string => `mev_${randomBytes(12).toString("hex")}`;

// Normalize a channel address for the (channel, address) unique
// index — trim whitespace, lowercase for email, and drop obvious
// separators from phone numbers so "+1 415-555-1212" and
// "+14155551212" collide as the same endpoint.
export const normalizeAddress = (
  channel: MessagingChannel,
  raw: string,
): string => {
  const trimmed = raw.trim();
  if (channel === "email") return trimmed.toLowerCase();
  return trimmed.replace(/[\s\-().]/g, "");
};

export const contactEndpointRepo = (db: Db) => ({
  create(input: CreateContactEndpointInput): ContactEndpointRow {
    const id = newEndpointId();
    const now = nowIso();
    const normalized = normalizeAddress(input.channel, input.address);
    db.insert(contactEndpoints)
      .values({
        id,
        householdId: input.householdId,
        channel: input.channel,
        address: normalized,
        principalId: input.principalId ?? null,
        label: input.label ?? null,
        createdAt: now,
      })
      .run();
    const row = db
      .select()
      .from(contactEndpoints)
      .where(eq(contactEndpoints.id, id))
      .get();
    if (!row) throw new Error("contact endpoint insert did not return");
    return row;
  },

  get(id: string): ContactEndpointRow | null {
    return (
      db.select().from(contactEndpoints).where(eq(contactEndpoints.id, id)).get() ??
      null
    );
  },

  // Resolve a contact endpoint from an inbound address. Ignores
  // revoked endpoints so a customer who lost a number can't route
  // through it. Returns null if unrouted.
  resolve(
    channel: MessagingChannel,
    address: string,
  ): ContactEndpointRow | null {
    const normalized = normalizeAddress(channel, address);
    return (
      db
        .select()
        .from(contactEndpoints)
        .where(
          and(
            eq(contactEndpoints.channel, channel),
            eq(contactEndpoints.address, normalized),
            isNull(contactEndpoints.revokedAt),
          ),
        )
        .get() ?? null
    );
  },

  list(householdId: HouseholdId): ContactEndpointRow[] {
    return db
      .select()
      .from(contactEndpoints)
      .where(eq(contactEndpoints.householdId, householdId))
      .orderBy(desc(contactEndpoints.createdAt))
      .all();
  },

  revoke(id: string): void {
    db.update(contactEndpoints)
      .set({ revokedAt: nowIso() })
      .where(eq(contactEndpoints.id, id))
      .run();
  },

  // Record a consent transition (opted_in, opted_out, or explicit
  // reset to unknown). Source names the action that produced this
  // status — "reply_yes" (customer completed the verification /
  // texted START), "reply_stop" (STOP keyword), "manager_asserted"
  // (direct-add path; operator carries compliance responsibility),
  // "invited" (initial invite send).
  setConsent(
    id: string,
    input: {
      status: "unknown" | "opted_in" | "opted_out";
      source: string;
    },
  ): void {
    db.update(contactEndpoints)
      .set({
        consentStatus: input.status,
        consentRecordedAt: nowIso(),
        consentSource: input.source,
      })
      .where(eq(contactEndpoints.id, id))
      .run();
  },
});

export interface RecordMessagingEventInput {
  readonly householdId: HouseholdId;
  readonly endpointId?: string;
  readonly direction: "inbound" | "outbound";
  readonly channel: MessagingChannel;
  readonly provider: string;
  readonly externalMessageId?: string;
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly body: string;
  readonly receivedAt?: string;
  readonly plannerRunId?: string;
  readonly sessionId?: string;
  readonly authoredByType?: "manager" | "agent" | "system";
  readonly authoredById?: string;
  readonly authoredByLabel?: string;
}

export const messagingEventRepo = (db: Db) => ({
  // Idempotent record: an inbound event with the same
  // (provider, external_message_id) is deduped to preserve at-most-
  // once planner dispatch on webhook retries. Returns { inserted }.
  record(
    input: RecordMessagingEventInput,
  ): { inserted: boolean; row: MessagingEventRow } {
    if (input.externalMessageId) {
      const existing = db
        .select()
        .from(messagingEvents)
        .where(
          and(
            eq(messagingEvents.provider, input.provider),
            eq(messagingEvents.externalMessageId, input.externalMessageId),
          ),
        )
        .get();
      if (existing) return { inserted: false, row: existing };
    }
    const id = newEventId();
    const now = nowIso();
    db.insert(messagingEvents)
      .values({
        id,
        householdId: input.householdId,
        endpointId: input.endpointId ?? null,
        direction: input.direction,
        channel: input.channel,
        provider: input.provider,
        externalMessageId: input.externalMessageId ?? null,
        fromAddress: input.fromAddress,
        toAddress: input.toAddress,
        body: input.body,
        receivedAt: input.receivedAt ?? now,
        plannerRunId: input.plannerRunId ?? null,
        createdAt: now,
        sessionId: input.sessionId ?? null,
        authoredByType: input.authoredByType ?? null,
        authoredById: input.authoredById ?? null,
        authoredByLabel: input.authoredByLabel ?? null,
      })
      .run();
    const row = db
      .select()
      .from(messagingEvents)
      .where(eq(messagingEvents.id, id))
      .get();
    if (!row) throw new Error("messaging event insert did not return");
    return { inserted: true, row };
  },

  list(householdId: HouseholdId, limit = 50): MessagingEventRow[] {
    return db
      .select()
      .from(messagingEvents)
      .where(eq(messagingEvents.householdId, householdId))
      .orderBy(desc(messagingEvents.receivedAt))
      .limit(limit)
      .all();
  },

  linkRun(id: string, plannerRunId: string): void {
    db.update(messagingEvents)
      .set({ plannerRunId })
      .where(eq(messagingEvents.id, id))
      .run();
  },

  linkSession(id: string, sessionId: string): void {
    db.update(messagingEvents)
      .set({ sessionId })
      .where(eq(messagingEvents.id, id))
      .run();
  },

  // Update delivery status from an async provider callback.
  // Idempotent — the same status can arrive twice on retry, and
  // rewriting the same row with the same values is safe.
  // Returns the number of rows updated so the caller can log
  // "no matching event" without a separate query.
  updateDeliveryStatus(input: {
    provider: string;
    externalMessageId: string;
    status: string;
    errorCode?: string;
  }): { updated: number } {
    const now = nowIso();
    const result = db
      .update(messagingEvents)
      .set({
        deliveryStatus: input.status,
        deliveryStatusAt: now,
        deliveryErrorCode: input.errorCode ?? null,
      })
      .where(
        and(
          eq(messagingEvents.provider, input.provider),
          eq(messagingEvents.externalMessageId, input.externalMessageId),
        ),
      )
      .run();
    return { updated: result.changes ?? 0 };
  },

  // Events belonging to one conversation session, oldest first.
  // Used by the planner-memory path to hand recent turns back into
  // the next planner call. Limited so a long session doesn't blow
  // the prompt window; caller can raise the limit if needed.
  listBySession(sessionId: string, limit = 20): MessagingEventRow[] {
    return db
      .select()
      .from(messagingEvents)
      .where(eq(messagingEvents.sessionId, sessionId))
      .orderBy(asc(messagingEvents.receivedAt))
      .limit(limit)
      .all();
  },
});

// Idle window before a session auto-closes and a new inbound
// opens a fresh one. 30 min matches the "one back-and-forth" feel
// of SMS — long enough to survive a bathroom break, short enough
// that "book me a car" from Tuesday isn't stitched into "what's
// the weather" from Thursday.
export const CONVERSATION_IDLE_MS = 30 * 60 * 1000;

const newSessionId = (): string => `ses_${randomBytes(12).toString("hex")}`;

export const conversationSessionRepo = (db: Db) => ({
  // Find the newest open session for the endpoint whose
  // lastActivityAt is still within the idle window; if none,
  // create one. Called on every inbound before planner dispatch,
  // so it must be cheap.
  openOrResume(input: {
    householdId: HouseholdId;
    endpointId: string;
    principalId?: string | null;
    nowMs?: number;
  }): { session: ConversationSessionRow; resumed: boolean } {
    const now = new Date(input.nowMs ?? Date.now());
    const nowStr = now.toISOString();
    const cutoff = new Date(now.getTime() - CONVERSATION_IDLE_MS).toISOString();

    const existing = db
      .select()
      .from(conversationSessions)
      .where(
        and(
          eq(conversationSessions.endpointId, input.endpointId),
          isNull(conversationSessions.closedAt),
          gt(conversationSessions.lastActivityAt, cutoff),
        ),
      )
      .orderBy(desc(conversationSessions.lastActivityAt))
      .get();
    if (existing) {
      db.update(conversationSessions)
        .set({ lastActivityAt: nowStr })
        .where(eq(conversationSessions.id, existing.id))
        .run();
      return { session: { ...existing, lastActivityAt: nowStr }, resumed: true };
    }

    const id = newSessionId();
    db.insert(conversationSessions)
      .values({
        id,
        householdId: input.householdId,
        endpointId: input.endpointId,
        principalId: input.principalId ?? null,
        startedAt: nowStr,
        lastActivityAt: nowStr,
        closedAt: null,
        topic: null,
      })
      .run();
    const row = db
      .select()
      .from(conversationSessions)
      .where(eq(conversationSessions.id, id))
      .get();
    if (!row) throw new Error("conversation session insert did not return");
    return { session: row, resumed: false };
  },

  // Manually close a session — used by the "customer said 'thanks
  // that's all'" path and by admin controls. Not required for
  // normal operation; idle timeout does the same thing implicitly.
  close(id: string): void {
    db.update(conversationSessions)
      .set({ closedAt: nowIso() })
      .where(eq(conversationSessions.id, id))
      .run();
  },

  get(id: string): ConversationSessionRow | null {
    return (
      db
        .select()
        .from(conversationSessions)
        .where(eq(conversationSessions.id, id))
        .get() ?? null
    );
  },

  listOpenForEndpoint(endpointId: string): ConversationSessionRow[] {
    return db
      .select()
      .from(conversationSessions)
      .where(
        and(
          eq(conversationSessions.endpointId, endpointId),
          isNull(conversationSessions.closedAt),
        ),
      )
      .orderBy(desc(conversationSessions.lastActivityAt))
      .all();
  },
});
