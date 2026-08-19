import { readGoogleAuth, type GoogleOAuthFields } from "./_google.js";
import type { HouseholdId } from "@atelier/domain";
import type { StoredCredential } from "../types.js";

// Google Calendar incremental sync via the events.list syncToken
// pattern. First call for a household: a bounded full pull (past
// horizon + future horizon) and we record the returned nextSyncToken.
// Subsequent calls: events.list?syncToken=<token> streams only
// changed events (including cancellations, showDeleted=true is
// implied when using syncToken). 410 Gone → the token has been
// invalidated (Google keeps them ~30 days); wipe and full-pull.
//
// Not a Tool — this is the calendar analogue of syncGmailInbox,
// invoked by the background scheduler or on-demand from the API.

const GOOGLE_CAL_BASE = "https://www.googleapis.com/calendar/v3";
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

interface GoogleEvent {
  id?: string;
  status?: string;
  summary?: string;
  location?: string;
  description?: string;
  htmlLink?: string;
  updated?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
}

interface GoogleListResponse {
  items?: GoogleEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

const startFromEvent = (e: GoogleEvent): { startAt: string; endAt?: string; allDay: boolean } | null => {
  if (e.start?.dateTime) {
    const startAt = e.start.dateTime;
    const endAt = e.end?.dateTime;
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

const walkPages = async (
  auth: { accessToken: string },
  buildUrl: (pageToken?: string) => string,
  onPage: (page: GoogleListResponse) => void,
): Promise<
  | { ok: true; syncToken: string | undefined }
  | { ok: false; status: number; error: string }
> => {
  let pageToken: string | undefined = undefined;
  let syncToken: string | undefined;
  // Cap iterations defensively; Google will return nextSyncToken on
  // the final page — we should never really loop this many times.
  for (let i = 0; i < 50; i++) {
    const url = buildUrl(pageToken);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { authorization: `Bearer ${auth.accessToken}` },
      });
    } catch (err) {
      return { ok: false, status: 0, error: `google_calendar_list_fetch: ${(err as Error).message}` };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      return { ok: false, status: res.status, error: `google_calendar_list_${res.status}: ${text.slice(0, 200)}` };
    }
    const json = (await res.json()) as GoogleListResponse;
    onPage(json);
    if (json.nextPageToken) {
      pageToken = json.nextPageToken;
      continue;
    }
    syncToken = json.nextSyncToken;
    break;
  }
  return { ok: true, syncToken };
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

  const calendarId = auth.calendar_id ?? "primary";
  const cursorStore = opts.cursorStore;
  const existingCursor = cursorStore?.read(ctx.householdId, "google_calendar") ?? null;

  const drain = (json: GoogleListResponse, acc: GoogleEvent[]): void => {
    for (const e of json.items ?? []) acc.push(e);
  };

  const runFull = async (): Promise<CalendarSyncResult> => {
    const pastDays = opts.pastDays ?? DEFAULT_PAST_DAYS;
    const futureDays = opts.futureDays ?? DEFAULT_FUTURE_DAYS;
    const timeMin = new Date(Date.now() - pastDays * 86400_000).toISOString();
    const timeMax = new Date(Date.now() + futureDays * 86400_000).toISOString();
    const items: GoogleEvent[] = [];

    const walk = await walkPages(
      auth,
      (pageToken) =>
        `${GOOGLE_CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events` +
        `?singleEvents=true` +
        `&showDeleted=true` +
        `&maxResults=${PAGE_MAX}` +
        `&timeMin=${encodeURIComponent(timeMin)}` +
        `&timeMax=${encodeURIComponent(timeMax)}` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""),
      (page) => drain(page, items),
    );
    if (!walk.ok) {
      return {
        consulted: true,
        mode: existingCursor ? "token_reset" : "full",
        listed: 0,
        upserted: 0,
        inserted: 0,
        updated: 0,
        cancelled: 0,
        error: walk.error,
      };
    }

    const applied = applyItems(items);
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
      listed: items.length,
      inserted: applied.inserted,
      updated: applied.updated,
      cancelled: applied.cancelled,
    });
    return {
      consulted: true,
      mode: existingCursor ? "token_reset" : "full",
      listed: items.length,
      upserted: applied.upserted,
      inserted: applied.inserted,
      updated: applied.updated,
      cancelled: applied.cancelled,
      ...(walk.syncToken ? { syncToken: walk.syncToken } : {}),
    };
  };

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

  // ── Incremental path: syncToken ──────────────────────────────
  if (cursorStore && existingCursor?.syncToken) {
    const items: GoogleEvent[] = [];
    let last410 = false;
    const walk = await walkPages(
      auth,
      (pageToken) =>
        `${GOOGLE_CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events` +
        `?syncToken=${encodeURIComponent(existingCursor.syncToken!)}` +
        `&maxResults=${PAGE_MAX}` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""),
      (page) => drain(page, items),
    );
    if (!walk.ok) {
      if (walk.status === 410) {
        cursorStore.clear(ctx.householdId, "google_calendar");
        ctx.logger?.info("google_calendar syncToken expired; resetting to full sync", {});
        last410 = true;
      } else {
        return {
          consulted: true,
          mode: "incremental",
          listed: 0,
          upserted: 0,
          inserted: 0,
          updated: 0,
          cancelled: 0,
          error: walk.error,
        };
      }
    }

    if (!last410) {
      if (items.length === 0) {
        if (walk.ok && walk.syncToken) {
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
          ...(walk.ok && walk.syncToken
            ? { syncToken: walk.syncToken }
            : { syncToken: existingCursor.syncToken }),
        };
      }
      const applied = applyItems(items);
      const nextToken =
        walk.ok && walk.syncToken ? walk.syncToken : existingCursor.syncToken;
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
        listed: items.length,
        upserted: applied.upserted,
        inserted: applied.inserted,
        updated: applied.updated,
        cancelled: applied.cancelled,
        syncToken: nextToken,
      };
    }
  }

  return await runFull();
};
