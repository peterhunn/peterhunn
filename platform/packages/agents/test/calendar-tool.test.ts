import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { calendarCreateTool, calendarRescheduleTool } from "../src/tools/calendar.js";
import type { HouseholdId } from "@atelier/domain";
import type { StoredCredential, ToolContext } from "../src/types.js";

const HH = "hh_test" as HouseholdId;

const stubFetch = (impl: (url: string, init?: RequestInit) => Response) => {
  vi.stubGlobal("fetch", vi.fn(async (u: string, i?: RequestInit) => impl(u, i)));
};

const mkCtx = (
  credential: Record<string, unknown> | null,
  expiresAt: string | null = null,
): ToolContext => ({
  householdId: HH,
  authorityId: "pol_test",
  proposedBy: { actor: "calendar_agent", version: "0.1.0" },
  readCredential: (provider) => {
    if (provider !== "google_calendar" || !credential) return null;
    return {
      id: "crd_test",
      credential,
      expiresAt,
    } satisfies StoredCredential;
  },
  logger: { info: () => {} },
});

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("calendar.create", () => {
  it("falls back to mock when no google_calendar credential is stored", async () => {
    stubFetch(() => new Response("network disabled", { status: 500 }));
    const res = await calendarCreateTool.invoke(mkCtx(null), {
      inputs: {
        title: "Board meeting",
        startAt: "2026-10-01T15:00:00.000Z",
        endAt: "2026-10-01T16:00:00.000Z",
        attendees: [],
      },
      summary: "Create",
    });
    expect(res.outcome).toBe("succeeded");
    expect(res.outputs.provider).toBe("mock");
    expect(res.outputs.eventRef.startsWith("mock-")).toBe(true);
  });

  it("POSTs to Google Calendar with the access token when a credential is present", async () => {
    stubFetch((url, init) => {
      expect(url).toContain("googleapis.com/calendar/v3/calendars/primary/events");
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer live-access-token");
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        summary?: string;
        start?: { dateTime?: string; timeZone?: string };
      };
      expect(body.summary).toBe("Board meeting");
      expect(body.start?.dateTime).toBe("2026-10-01T15:00:00.000Z");
      expect(body.start?.timeZone).toBe("America/Chicago");
      return new Response(
        JSON.stringify({
          id: "gc_evt_123",
          start: { dateTime: "2026-10-01T15:00:00.000Z" },
          end: { dateTime: "2026-10-01T16:00:00.000Z" },
        }),
        { status: 200 },
      );
    });

    const res = await calendarCreateTool.invoke(
      mkCtx({
        access_token: "live-access-token",
        calendar_id: "primary",
        time_zone: "America/Chicago",
      }),
      {
        inputs: {
          title: "Board meeting",
          startAt: "2026-10-01T15:00:00.000Z",
          endAt: "2026-10-01T16:00:00.000Z",
          attendees: [],
        },
        summary: "Create",
      },
    );
    expect(res.outputs.provider).toBe("google_calendar");
    expect(res.outputs.eventRef).toBe("gc_evt_123");
  });

  it("refreshes an expired access token via the OAuth token endpoint", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    let n = 0;
    stubFetch((url, init) => {
      n++;
      if (n === 1) {
        expect(url).toBe("https://oauth2.googleapis.com/token");
        const body = String(init?.body ?? "");
        expect(body).toContain("grant_type=refresh_token");
        expect(body).toContain("refresh_token=rt-abc");
        return new Response(
          JSON.stringify({ access_token: "fresh-token", expires_in: 3600 }),
          { status: 200 },
        );
      }
      expect(url).toContain("googleapis.com/calendar/v3");
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer fresh-token");
      return new Response(
        JSON.stringify({
          id: "gc_evt_refreshed",
          start: { dateTime: "2026-10-01T15:00:00.000Z" },
          end: { dateTime: "2026-10-01T16:00:00.000Z" },
        }),
        { status: 200 },
      );
    });

    const res = await calendarCreateTool.invoke(
      mkCtx(
        {
          access_token: "old-token",
          refresh_token: "rt-abc",
          client_id: "cid",
          client_secret: "csec",
          calendar_id: "primary",
          time_zone: "UTC",
        },
        past,
      ),
      {
        inputs: {
          title: "After refresh",
          startAt: "2026-10-01T15:00:00.000Z",
          endAt: "2026-10-01T16:00:00.000Z",
          attendees: [],
        },
        summary: "Create",
      },
    );
    expect(res.outputs.provider).toBe("google_calendar");
    expect(res.outputs.eventRef).toBe("gc_evt_refreshed");
  });

  it("falls back to mock if the Google API returns an error", async () => {
    stubFetch(() => new Response("nope", { status: 500 }));
    const res = await calendarCreateTool.invoke(
      mkCtx({ access_token: "t", calendar_id: "primary", time_zone: "UTC" }),
      {
        inputs: {
          title: "Board meeting",
          startAt: "2026-10-01T15:00:00.000Z",
          endAt: "2026-10-01T16:00:00.000Z",
          attendees: [],
        },
        summary: "Create",
      },
    );
    expect(res.outputs.provider).toBe("mock");
  });
});

describe("calendar.reschedule", () => {
  it("PATCHes Google Calendar for a real event id", async () => {
    stubFetch((url, init) => {
      expect(init?.method).toBe("PATCH");
      expect(url).toContain("/events/gc_evt_123");
      return new Response(
        JSON.stringify({
          id: "gc_evt_123",
          start: { dateTime: "2026-10-01T18:00:00.000Z" },
          end: { dateTime: "2026-10-01T19:00:00.000Z" },
        }),
        { status: 200 },
      );
    });
    const res = await calendarRescheduleTool.invoke(
      mkCtx({ access_token: "t", calendar_id: "primary", time_zone: "UTC" }),
      {
        inputs: {
          eventRef: "gc_evt_123",
          fromStartAt: "2026-10-01T15:00:00.000Z",
          toStartAt: "2026-10-01T18:00:00.000Z",
          toEndAt: "2026-10-01T19:00:00.000Z",
        },
        summary: "Reschedule",
      },
    );
    expect(res.outputs.provider).toBe("google_calendar");
    expect(res.outputs.startAt).toBe("2026-10-01T18:00:00.000Z");
  });

  it("skips Google when the event ref looks synthetic (mock- / nod_)", async () => {
    let called = false;
    stubFetch(() => {
      called = true;
      return new Response("shouldn't be called", { status: 200 });
    });
    const res = await calendarRescheduleTool.invoke(
      mkCtx({ access_token: "t", calendar_id: "primary", time_zone: "UTC" }),
      {
        inputs: {
          eventRef: "mock-abc",
          fromStartAt: "2026-10-01T15:00:00.000Z",
          toStartAt: "2026-10-01T18:00:00.000Z",
        },
        summary: "Reschedule",
      },
    );
    expect(called).toBe(false);
    expect(res.outputs.provider).toBe("mock");
  });
});
