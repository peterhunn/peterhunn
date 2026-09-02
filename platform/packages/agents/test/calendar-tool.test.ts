import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { calendarCreateTool, calendarRescheduleTool } from "../src/tools/calendar.js";
import type { HouseholdId } from "@atelier/domain";
import type { StoredCredential, ToolContext } from "../src/types.js";

const CAL = "https://www.googleapis.com/calendar/v3";
const OAUTH_TOKEN = "https://oauth2.googleapis.com/token";
const HH = "hh_test" as HouseholdId;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const mkCtx = (
  credential: Record<string, unknown> | null,
  expiresAt: string | null = null,
  persist?: (id: string, at: string, exp: string) => void,
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
  ...(persist && { persistAccessToken: persist }),
  logger: { info: () => {} },
});

describe("calendar.create", () => {
  it("falls back to mock when no google_calendar credential is stored", async () => {
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
    server.use(
      http.post(
        `${CAL}/calendars/primary/events`,
        async ({ request }) => {
          const auth = request.headers.get("authorization");
          expect(auth).toBe("Bearer live-access-token");
          const body = (await request.json()) as {
            summary?: string;
            start?: { dateTime?: string; timeZone?: string };
          };
          expect(body.summary).toBe("Board meeting");
          expect(body.start?.dateTime).toBe("2026-10-01T15:00:00.000Z");
          expect(body.start?.timeZone).toBe("America/Chicago");
          return HttpResponse.json({
            id: "gc_evt_123",
            start: { dateTime: "2026-10-01T15:00:00.000Z" },
            end: { dateTime: "2026-10-01T16:00:00.000Z" },
          });
        },
      ),
    );

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
    server.use(
      http.post(OAUTH_TOKEN, async ({ request }) => {
        const body = await request.text();
        expect(body).toContain("grant_type=refresh_token");
        expect(body).toContain("refresh_token=rt-abc");
        return HttpResponse.json({
          access_token: "fresh-token",
          expires_in: 3600,
          token_type: "Bearer",
        });
      }),
      http.post(`${CAL}/calendars/primary/events`, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer fresh-token");
        return HttpResponse.json({
          id: "gc_evt_refreshed",
          start: { dateTime: "2026-10-01T15:00:00.000Z" },
          end: { dateTime: "2026-10-01T16:00:00.000Z" },
        });
      }),
    );

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

  it("persists the refreshed access token via ctx.persistAccessToken", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const persisted: Array<{ id: string; token: string; expiresAt: string }> = [];
    server.use(
      http.post(OAUTH_TOKEN, () =>
        HttpResponse.json({
          access_token: "fresh-token",
          expires_in: 3600,
          token_type: "Bearer",
        }),
      ),
      http.post(`${CAL}/calendars/primary/events`, () =>
        HttpResponse.json({
          id: "gc_ok",
          start: { dateTime: "2026-10-01T15:00:00.000Z" },
          end: { dateTime: "2026-10-01T16:00:00.000Z" },
        }),
      ),
    );
    await calendarCreateTool.invoke(
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
        (id, at, exp) => persisted.push({ id, token: at, expiresAt: exp }),
      ),
      {
        inputs: {
          title: "T",
          startAt: "2026-10-01T15:00:00.000Z",
          endAt: "2026-10-01T16:00:00.000Z",
          attendees: [],
        },
        summary: "Create",
      },
    );
    expect(persisted.length).toBeGreaterThanOrEqual(1);
    expect(persisted[0]!.id).toBe("crd_test");
    expect(persisted[0]!.token).toBe("fresh-token");
    expect(Date.parse(persisted[0]!.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("falls back to mock if the Google API returns an error", async () => {
    server.use(
      http.post(`${CAL}/calendars/primary/events`, () =>
        HttpResponse.text("nope", { status: 500 }),
      ),
    );
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
    server.use(
      http.patch(
        `${CAL}/calendars/primary/events/gc_evt_123`,
        () =>
          HttpResponse.json({
            id: "gc_evt_123",
            start: { dateTime: "2026-10-01T18:00:00.000Z" },
            end: { dateTime: "2026-10-01T19:00:00.000Z" },
          }),
      ),
    );
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
    // No handlers registered — if the tool DID call Google, msw
    // would fail with onUnhandledRequest: "error". Absence of a
    // failure is the assertion.
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
    expect(res.outputs.provider).toBe("mock");
  });
});
