import calendarApi, { type calendar_v3 } from "@googleapis/calendar";
import { readGoogleAuth, type GoogleOAuthFields } from "./_google.js";
import type { HouseholdId } from "@atelier/domain";
import type { StoredCredential } from "../types.js";

// Google Calendar incremental sync via the events.list syncToken
// pattern. First call for a household: a bounded full pull (past
// horizon + future horizon) and we record the returned nextSyncToken.
// Subsequent calls: events.list with syncToken streams only changed
// events (including cancellations, showDeleted=true is implied when
// using syncToken). 410 Gone → the token has been invalidated
// (Google keeps them ~30 days); wipe and full-pull.
//
// Uses @googleapis/calendar for the events.list calls; the control
// flow (cursor read → incremental / full → apply items → persist
// cursor) stays exactly as before. 410/404 detection is against the
// SDK's error.code numeric.
//
// Not a Tool — this is the calendar analogue of syncGmailInbox,
// invoked by the background scheduler or on-demand from the API.

const DEFAULT_PAST_DAYS = 30;
const DEFAULT_FUTURE_DAYS = 365;
const PAGE_MAX = 250;

interface GoogleCalendarFields extends GoogleOAuthFields {
  readonly calendar_id?: string;
}

export interface CalendarSyncSink {
  upsertEvent(input: {
    householdId: HouseholdId;
    externalProvider: "google_calendar";
    externalCalendarId: string;
    externalEventId: string;
    title: string;
    location?: string;
    description?: string;
    startAt: string;
    endAt?: string;
    allDay?: boolean;
    status?: "confirmed" | "tentative" | "cancelled";
    htmlLink?: string;
    externalUpdatedAt?: string;
  }): { inserted: boolean; updated: boolean };
}

export interface CalendarSyncCursor {
  read(
    householdId: HouseholdId,
    provider: "google_calendar",
  ): { syncToken?: string } | null;
  save(
    householdId: HouseholdId,
    provider: "google_calendar",
    cursor: { syncToken: string },
    lastResult?: unknown,
  ): void;
  clear(householdId: HouseholdId, provider: "google_calendar"): void;
}

export interface CalendarSyncContext {
  readonly householdId: HouseholdId;
  readonly readCredential: (provider: string) => StoredCredential | null;
  readonly persistAccessToken?: (
    credentialId: string,
    accessToken: string,
    expiresAt: string,
  ) => void;
  readonly logger?: { info: (msg: string, ctx?: unknown) => void };
}

export interface CalendarSyncResult {
  readonly consulted: boolean;
  readonly mode: "full" | "incremental" | "up_to_date" | "token_reset" | "none";
  readonly listed: number;
  readonly upserted: number;
  readonly inserted: number;
  readonly updated: number;
  readonly cancelled: number;
  readonly syncToken?: string;
  readonly error?: string;
}

type GoogleEvent = calendar_v3.Schema$Event;

const startFromEvent = (
  e: GoogleEvent,
): { startAt: string; endAt?: string; allDay: boolean } | null => {
  if (e.start?.dateTime) {
    const startAt = e.start.dateTime;
    const endAt = e.end?.dateTime ?? undefined;
    return endAt ? { startAt, endAt, allDay: false } : { startAt, allDay: false };
  }
  if (e.start?.date) {
    // All-day event; normalize to midnight UTC iso.
    const startAt = `${e.start.date}T00:00:00.000Z`;
    const endAt = e.end?.date ? `${e.end.date}T00:00:00.000Z` : undefined;
    return endAt ? { startAt, endAt, allDay: true } : { startAt, allDay: true };
  }
  // Cancelled events on a syncToken pull carry no start; that's fine.
  if (e.status === "cancelled") return { startAt: new Date(0).toISOString(), allDay: false };
  return null;
};

const calErrCode = (err: unknown): number | undefined => {
  const e = err as { code?: number | string; status?: number };
  const raw = e?.code ?? e?.status;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

// Walk paginated events.list, collect items, return the terminal
// nextSyncToken. Uses either the syncToken or the timeMin/timeMax
// mode based on which is passed. Errors bubble up so the caller can
// distinguish 410 (syncToken expired) from other statuses.
const walkPages = async (
  calendar: calendar_v3.Calendar,
  base: calendar_v3.Params$Resource$Events$List,
): Promise<{ items: GoogleEvent[]; syncToken: string | undefined }> => {
  let pageToken: string | undefined = undefined;
  let syncToken: string | undefined;
  const items: GoogleEvent[] = [];
  for (let i = 0; i < 50; i++) {
    const params: calendar_v3.Params$Resource$Events$List = {
      ...base,
      maxResults: PAGE_MAX,
      ...(pageToken ? { pageToken } : {}),
    };
    const res = await calendar.events.list(params);
    for (const it of res.data.items ?? []) items.push(it);
    if (res.data.nextPageToken) {
      pageToken = res.data.nextPageToken;
      continue;
    }
    syncToken = res.data.nextSyncToken ?? undefined;
    break;
  }
  return { items, syncToken };
};

export const syncGoogleCalendar = async (
  ctx: CalendarSyncContext,
  sink: CalendarSyncSink,
  opts: {
    pastDays?: number;
    futureDays?: number;
    cursorStore?: CalendarSyncCursor;
  } = {},
): Promise<CalendarSyncResult> => {
  const auth = await readGoogleAuth<GoogleCalendarFields>(
    {
      ...ctx,
      authorityId: undefined,
      proposedBy: { actor: "calendar_sync", version: "0.1.0" },
    },
    "google_calendar",
  );
  if (!auth) {
    return {
      consulted: false,
      mode: "none",
      listed: 0,
      upserted: 0,
      inserted: 0,
      updated: 0,
      cancelled: 0,
    };
  }

  const calendar = calendarApi.calendar({ version: "v3", auth: auth.client });
  const calendarId = auth.credential.calendar_id ?? "primary";
  const cursorStore = opts.cursorStore;
  const existingCursor = cursorStore?.read(ctx.householdId, "google_calendar") ?? null;

  const applyItems = (
    items: readonly GoogleEvent[],
  ): { upserted: number; inserted: number; updated: number; cancelled: number } => {
    let inserted = 0;
    let updated = 0;
    let cancelled = 0;
    let upserted = 0;
    for (const e of items) {
      if (!e.id) continue;
      const times = startFromEvent(e);
      if (!times) continue;
      const status: "confirmed" | "tentative" | "cancelled" =
        e.status === "cancelled"
          ? "cancelled"
          : e.status === "tentative"
            ? "tentative"
            : "confirmed";
      if (status === "cancelled") cancelled++;
      const { inserted: didInsert, updated: didUpdate } = sink.upsertEvent({
        householdId: ctx.householdId,
        externalProvider: "google_calendar",
        externalCalendarId: calendarId,
        externalEventId: e.id,
        title: e.summary ?? "(no title)",
        ...(e.location ? { location: e.location } : {}),
        ...(e.description ? { description: e.description } : {}),
        startAt: times.startAt,
        ...(times.endAt ? { endAt: times.endAt } : {}),
        allDay: times.allDay,
        status,
        ...(e.htmlLink ? { htmlLink: e.htmlLink } : {}),
        ...(e.updated ? { externalUpdatedAt: e.updated } : {}),
      });
      if (didInsert) inserted++;
      if (didUpdate) updated++;
      if (didInsert || didUpdate) upserted++;
    }
    return { upserted, inserted, updated, cancelled };
  };

  const runFull = async (): Promise<CalendarSyncResult> => {
    const pastDays = opts.pastDays ?? DEFAULT_PAST_DAYS;
    const futureDays = opts.futureDays ?? DEFAULT_FUTURE_DAYS;
    const timeMin = new Date(Date.now() - pastDays * 86400_000).toISOString();
    const timeMax = new Date(Date.now() + futureDays * 86400_000).toISOString();

    let walk: Awaited<ReturnType<typeof walkPages>>;
    try {
      walk = await walkPages(calendar, {
        calendarId,
        singleEvents: true,
        showDeleted: true,
        timeMin,
        timeMax,
      });
    } catch (err) {
      return {
        consulted: true,
        mode: existingCursor ? "token_reset" : "full",
        listed: 0,
        upserted: 0,
        inserted: 0,
        updated: 0,
        cancelled: 0,
        error: `google_calendar_list_${calErrCode(err) ?? "err"}: ${(err as Error).message.slice(0, 200)}`,
      };
    }

    const applied = applyItems(walk.items);
    if (cursorStore && walk.syncToken) {
      cursorStore.save(
        ctx.householdId,
        "google_calendar",
        { syncToken: walk.syncToken },
        {
          at: new Date().toISOString(),
          mode: existingCursor ? "token_reset" : "full",
          inserted: applied.inserted,
          updated: applied.updated,
        },
      );
    }
    ctx.logger?.info("google_calendar sync completed", {
      mode: existingCursor ? "token_reset" : "full",
      listed: walk.items.length,
      inserted: applied.inserted,
      updated: applied.updated,
      cancelled: applied.cancelled,
    });
    return {
      consulted: true,
      mode: existingCursor ? "token_reset" : "full",
      listed: walk.items.length,
      upserted: applied.upserted,
      inserted: applied.inserted,
      updated: applied.updated,
      cancelled: applied.cancelled,
      ...(walk.syncToken ? { syncToken: walk.syncToken } : {}),
    };
  };

  // ── Incremental path: syncToken ──────────────────────────────
  if (cursorStore && existingCursor?.syncToken) {
    let walk: Awaited<ReturnType<typeof walkPages>>;
    try {
      walk = await walkPages(calendar, {
        calendarId,
        syncToken: existingCursor.syncToken,
      });
    } catch (err) {
      if (calErrCode(err) === 410) {
        cursorStore.clear(ctx.householdId, "google_calendar");
        ctx.logger?.info("google_calendar syncToken expired; resetting to full sync", {});
        return await runFull();
      }
      return {
        consulted: true,
        mode: "incremental",
        listed: 0,
        upserted: 0,
        inserted: 0,
        updated: 0,
        cancelled: 0,
        error: `google_calendar_list_${calErrCode(err) ?? "err"}: ${(err as Error).message.slice(0, 200)}`,
      };
    }

    if (walk.items.length === 0) {
      if (walk.syncToken) {
        cursorStore.save(
          ctx.householdId,
          "google_calendar",
          { syncToken: walk.syncToken },
          { at: new Date().toISOString(), mode: "up_to_date" },
        );
      }
      return {
        consulted: true,
        mode: "up_to_date",
        listed: 0,
        upserted: 0,
        inserted: 0,
        updated: 0,
        cancelled: 0,
        syncToken: walk.syncToken ?? existingCursor.syncToken,
      };
    }

    const applied = applyItems(walk.items);
    const nextToken = walk.syncToken ?? existingCursor.syncToken;
    cursorStore.save(
      ctx.householdId,
      "google_calendar",
      { syncToken: nextToken },
      {
        at: new Date().toISOString(),
        mode: "incremental",
        inserted: applied.inserted,
        updated: applied.updated,
      },
    );
    return {
      consulted: true,
      mode: "incremental",
      listed: walk.items.length,
      upserted: applied.upserted,
      inserted: applied.inserted,
      updated: applied.updated,
      cancelled: applied.cancelled,
      syncToken: nextToken,
    };
  }

  return await runFull();
};
