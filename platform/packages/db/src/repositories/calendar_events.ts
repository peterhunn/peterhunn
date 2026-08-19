import { randomBytes } from "node:crypto";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { nowIso, type HouseholdId } from "@atelier/domain";
import type { Db } from "../client.js";
import { calendarEvents, type CalendarEventRow } from "../schema/calendar_events.js";

export interface UpsertExternalCalendarEventInput {
  readonly householdId: HouseholdId;
  readonly externalProvider: "google_calendar";
  readonly externalCalendarId: string;
  readonly externalEventId: string;
  readonly title: string;
  readonly location?: string;
  readonly description?: string;
  readonly startAt: string;
  readonly endAt?: string;
  readonly allDay?: boolean;
  readonly status?: "confirmed" | "tentative" | "cancelled";
  readonly htmlLink?: string;
  readonly externalUpdatedAt?: string;
}

const newEventId = (): string => `evt_${randomBytes(12).toString("hex")}`;

export const calendarEventRepo = (db: Db) => ({
  list(
    householdId: HouseholdId,
    opts: { windowStart?: string; windowEnd?: string; limit?: number } = {},
  ): CalendarEventRow[] {
    const conditions = [eq(calendarEvents.householdId, householdId)];
    if (opts.windowStart) conditions.push(gte(calendarEvents.startAt, opts.windowStart));
    if (opts.windowEnd) conditions.push(lte(calendarEvents.startAt, opts.windowEnd));
    return db
      .select()
      .from(calendarEvents)
      .where(and(...conditions))
      .orderBy(asc(calendarEvents.startAt))
      .limit(opts.limit ?? 200)
      .all();
  },

  // Insert on first sight, update on repeat. Keyed by
  // (external_provider, external_event_id) via the unique index.
  // Cancellations arrive as status="cancelled" from the provider;
  // we record deletedAt but keep the row so downstream can dedupe
  // against prior graph nodes.
  upsertExternal(input: UpsertExternalCalendarEventInput): {
    inserted: boolean;
    updated: boolean;
    row: CalendarEventRow;
  } {
    const existing = db
      .select()
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.externalProvider, input.externalProvider),
          eq(calendarEvents.externalEventId, input.externalEventId),
        ),
      )
      .get();

    const now = nowIso();
    const status = input.status ?? "confirmed";
    const deletedAt = status === "cancelled" ? now : null;

    if (existing) {
      db.update(calendarEvents)
        .set({
          title: input.title,
          location: input.location ?? null,
          description: input.description ?? null,
          startAt: input.startAt,
          endAt: input.endAt ?? null,
          allDay: input.allDay ? "yes" : "no",
          status,
          htmlLink: input.htmlLink ?? existing.htmlLink,
          externalUpdatedAt: input.externalUpdatedAt ?? existing.externalUpdatedAt,
          updatedAt: now,
          deletedAt: status === "cancelled" ? (existing.deletedAt ?? now) : null,
        })
        .where(eq(calendarEvents.id, existing.id))
        .run();
      const row = db
        .select()
        .from(calendarEvents)
        .where(eq(calendarEvents.id, existing.id))
        .get();
      if (!row) throw new Error("calendar event update did not return");
      return { inserted: false, updated: true, row };
    }

    const id = newEventId();
    db.insert(calendarEvents)
      .values({
        id,
        householdId: input.householdId,
        externalProvider: input.externalProvider,
        externalCalendarId: input.externalCalendarId,
        externalEventId: input.externalEventId,
        title: input.title,
        location: input.location ?? null,
        description: input.description ?? null,
        startAt: input.startAt,
        endAt: input.endAt ?? null,
        allDay: input.allDay ? "yes" : "no",
        status,
        htmlLink: input.htmlLink ?? null,
        externalUpdatedAt: input.externalUpdatedAt ?? null,
        updatedAt: now,
        deletedAt,
      })
      .run();
    const row = db.select().from(calendarEvents).where(eq(calendarEvents.id, id)).get();
    if (!row) throw new Error("calendar event insert did not return");
    return { inserted: true, updated: false, row };
  },
});
