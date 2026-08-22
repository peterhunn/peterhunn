import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  syncGoogleCalendar,
  type CalendarSyncCursor,
} from "../src/tools/calendar-sync.js";
import type { HouseholdId } from "@atelier/domain";
import type { StoredCredential } from "../src/types.js";

const CAL = "https://www.googleapis.com/calendar/v3";
const HH = "hh_test" as HouseholdId;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const mkCtx = (credential: Record<string, unknown> | null) => ({
  householdId: HH,
  readCredential: (provider: string) => {
    if (provider !== "google_calendar" || !credential) return null;
    return {
      id: "crd_test",
      credential,
      expiresAt: null,
    } satisfies StoredCredential;
  },
  logger: { info: () => {} },
});

interface UpsertRecord {
  externalEventId: string;
  title: string;
  startAt: string;
  status: string;
}

const mkSink = () => {
  const rows = new Map<string, UpsertRecord>();
  return {
    rows,
    upsertEvent: (e: {
      externalEventId: string;
      title: string;
      startAt: string;
      status?: string;
    }) => {
      const existed = rows.has(e.externalEventId);
      rows.set(e.externalEventId, {
        externalEventId: e.externalEventId,
        title: e.title,
        startAt: e.startAt,
        status: e.status ?? "confirmed",
      });
      return { inserted: !existed, updated: existed };
    },
  };
};

const mkCursor = (): CalendarSyncCursor & {
  saved: Array<{ syncToken: string }>;
} => {
  let current: { syncToken?: string } | null = null;
  const saved: Array<{ syncToken: string }> = [];
  return {
    saved,
    read: () => (current?.syncToken ? { syncToken: current.syncToken } : null),
    save: (_h, _p, c) => {
      current = { syncToken: c.syncToken };
      saved.push({ syncToken: c.syncToken });
    },
    clear: () => {
      current = null;
    },
  };
};

describe("Google Calendar incremental sync", () => {
  it("returns consulted:false when no google_calendar credential is stored", async () => {
    const res = await syncGoogleCalendar(mkCtx(null), mkSink(), {});
    expect(res.consulted).toBe(false);
    expect(res.mode).toBe("none");
  });

  it("does a full pull on the first call and records the nextSyncToken", async () => {
    server.use(
      http.get(`${CAL}/calendars/primary/events`, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.has("syncToken")).toBe(false);
        return HttpResponse.json({
          items: [
            {
              id: "evt_a",
              status: "confirmed",
              summary: "Team standup",
              start: { dateTime: "2026-08-20T15:00:00Z" },
              end: { dateTime: "2026-08-20T15:30:00Z" },
            },
            {
              id: "evt_b",
              status: "tentative",
              summary: "Coffee with Sam",
              start: { dateTime: "2026-08-21T17:00:00Z" },
              end: { dateTime: "2026-08-21T18:00:00Z" },
            },
          ],
          nextSyncToken: "TOK-FULL-1",
        });
      }),
    );

    const sink = mkSink();
    const cursor = mkCursor();
    const res = await syncGoogleCalendar(
      mkCtx({ access_token: "at" }),
      sink,
      { cursorStore: cursor },
    );

    expect(res.consulted).toBe(true);
    expect(res.mode).toBe("full");
    expect(res.listed).toBe(2);
    expect(res.inserted).toBe(2);
    expect(res.syncToken).toBe("TOK-FULL-1");
    expect(sink.rows.get("evt_a")?.title).toBe("Team standup");
    expect(sink.rows.get("evt_b")?.status).toBe("tentative");
    expect(cursor.saved.at(-1)?.syncToken).toBe("TOK-FULL-1");
  });

  it("uses the stored syncToken on subsequent calls and marks cancellations", async () => {
    server.use(
      http.get(`${CAL}/calendars/primary/events`, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("syncToken")).toBe("TOK-PRIOR");
        return HttpResponse.json({
          items: [
            { id: "evt_a", status: "cancelled" },
            {
              id: "evt_c",
              status: "confirmed",
              summary: "New event",
              start: { dateTime: "2026-09-01T14:00:00Z" },
              end: { dateTime: "2026-09-01T15:00:00Z" },
            },
          ],
          nextSyncToken: "TOK-NEXT",
        });
      }),
    );

    const sink = mkSink();
    const cursor: CalendarSyncCursor = {
      read: () => ({ syncToken: "TOK-PRIOR" }),
      save: vi.fn(),
      clear: vi.fn(),
    };
    const res = await syncGoogleCalendar(
      mkCtx({ access_token: "at" }),
      sink,
      { cursorStore: cursor },
    );

    expect(res.mode).toBe("incremental");
    expect(res.listed).toBe(2);
    expect(res.cancelled).toBe(1);
    expect(res.syncToken).toBe("TOK-NEXT");
    expect(sink.rows.get("evt_a")?.status).toBe("cancelled");
    expect(sink.rows.get("evt_c")?.title).toBe("New event");
    expect(cursor.save).toHaveBeenCalledWith(
      HH,
      "google_calendar",
      { syncToken: "TOK-NEXT" },
      expect.any(Object),
    );
  });

  it("410 on syncToken clears cursor and falls back to a full pull", async () => {
    let call = 0;
    server.use(
      http.get(`${CAL}/calendars/primary/events`, ({ request }) => {
        call++;
        const url = new URL(request.url);
        if (call === 1) {
          expect(url.searchParams.get("syncToken")).toBe("STALE");
          return HttpResponse.text("gone", { status: 410 });
        }
        // Full pull after reset — no syncToken.
        expect(url.searchParams.has("syncToken")).toBe(false);
        return HttpResponse.json({
          items: [
            {
              id: "evt_only",
              status: "confirmed",
              summary: "Fresh",
              start: { dateTime: "2026-08-25T15:00:00Z" },
              end: { dateTime: "2026-08-25T15:30:00Z" },
            },
          ],
          nextSyncToken: "TOK-AFTER-RESET",
        });
      }),
    );

    const sink = mkSink();
    const cleared = vi.fn();
    const saved = vi.fn();
    const cursor: CalendarSyncCursor = {
      read: () => ({ syncToken: "STALE" }),
      save: saved,
      clear: cleared,
    };
    const res = await syncGoogleCalendar(
      mkCtx({ access_token: "at" }),
      sink,
      { cursorStore: cursor },
    );
    expect(cleared).toHaveBeenCalledWith(HH, "google_calendar");
    expect(res.mode).toBe("token_reset");
    expect(res.inserted).toBe(1);
    expect(res.syncToken).toBe("TOK-AFTER-RESET");
    expect(saved).toHaveBeenCalledWith(
      HH,
      "google_calendar",
      { syncToken: "TOK-AFTER-RESET" },
      expect.any(Object),
    );
  });

  it("empty incremental page returns up_to_date and advances the token", async () => {
    server.use(
      http.get(`${CAL}/calendars/primary/events`, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("syncToken")).toBe("TOK-A");
        return HttpResponse.json({ items: [], nextSyncToken: "TOK-B" });
      }),
    );

    const sink = mkSink();
    const saved = vi.fn();
    const cursor: CalendarSyncCursor = {
      read: () => ({ syncToken: "TOK-A" }),
      save: saved,
      clear: vi.fn(),
    };
    const res = await syncGoogleCalendar(
      mkCtx({ access_token: "at" }),
      sink,
      { cursorStore: cursor },
    );
    expect(res.mode).toBe("up_to_date");
    expect(res.inserted).toBe(0);
    expect(res.syncToken).toBe("TOK-B");
    expect(saved).toHaveBeenCalled();
  });
});
