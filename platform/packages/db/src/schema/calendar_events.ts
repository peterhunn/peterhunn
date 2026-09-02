import { sqliteTable, text, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { households } from "./households.js";

// Mirror of external calendar events (Google Calendar today) so the
// platform can reason about a household's schedule without hitting
// the provider on every read. Populated by the background sync; the
// authoritative record still lives on the provider.
//
// Not the Life Graph — the graph stores obligations + facts (nodes
// with provenance + confidence). This table is a cache of raw
// external events, keyed by external id for dedupe, and it collapses
// to nothing if the credential is revoked.
export const calendarEvents = sqliteTable(
  "calendar_events",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),

    externalProvider: text("external_provider").notNull(),
    externalCalendarId: text("external_calendar_id").notNull(),
    externalEventId: text("external_event_id").notNull(),

    title: text("title").notNull(),
    location: text("location"),
    description: text("description"),
    startAt: text("start_at").notNull(),
    endAt: text("end_at"),
    allDay: text("all_day", { enum: ["yes", "no"] }).notNull().default("no"),

    status: text("status", { enum: ["confirmed", "tentative", "cancelled"] })
      .notNull()
      .default("confirmed"),

    htmlLink: text("html_link"),
    externalUpdatedAt: text("external_updated_at"),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (t) => ({
    householdStartIdx: index("calendar_events_household_start_idx").on(
      t.householdId,
      t.startAt,
    ),
    externalIdIdx: uniqueIndex("calendar_events_external_id_uidx").on(
      t.externalProvider,
      t.externalEventId,
    ),
  }),
);

export type CalendarEventRow = typeof calendarEvents.$inferSelect;
export type NewCalendarEventRow = typeof calendarEvents.$inferInsert;
