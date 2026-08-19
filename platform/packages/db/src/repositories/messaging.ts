import { randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { nowIso, type HouseholdId } from "@atelier/domain";
import type { Db } from "../client.js";
import {
  contactEndpoints,
  messagingEvents,
  type ContactEndpointRow,
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
});
