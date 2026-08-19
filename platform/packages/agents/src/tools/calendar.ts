import { z } from "zod";
import type { Tool, ToolContext } from "../types.js";
import { readGoogleAuth, type GoogleOAuthFields } from "./_google.js";

// Calendar tools. Prefer a real Google Calendar API call when the
// household has connected a google_calendar credential; otherwise
// fall back to a deterministic mock. Real adapters carry ownership
// of external side effects; the mock is the never-silent fallback.

const GOOGLE_CAL_BASE = "https://www.googleapis.com/calendar/v3";

interface GoogleCalendarFields extends GoogleOAuthFields {
  readonly calendar_id?: string;
  readonly time_zone?: string;
}

const ensureAccessToken = async (
  ctx: ToolContext,
): Promise<{ accessToken: string; calendarId: string; timeZone: string } | null> => {
  const auth = await readGoogleAuth<GoogleCalendarFields>(ctx, "google_calendar");
  if (!auth) return null;
  return {
    accessToken: auth.accessToken,
    calendarId: auth.calendar_id ?? "primary",
    timeZone: auth.time_zone ?? "UTC",
  };
};

// ─── calendar.create ────────────────────────────────────────────

export const CalendarCreateInputs = z.object({
  title: z.string(),
  startAt: z.string().datetime(),
  endAt: z.string().datetime().optional(),
  location: z.string().optional(),
  attendees: z.array(z.string()).default([]),
  notes: z.string().optional(),
});
export type CalendarCreateInputs = z.infer<typeof CalendarCreateInputs>;

export interface CalendarCreateOutputs {
  readonly eventRef: string;
  readonly startAt: string;
  readonly endAt: string | undefined;
  readonly provider: "google_calendar" | "mock";
}

export const calendarCreateTool: Tool<CalendarCreateInputs, CalendarCreateOutputs> = {
  name: "calendar.create",
  version: "0.2.0",
  sideEffectClass: "write_reversible",
  domain: "calendar",
  actionClass: "calendar.appointment.create",

  async invoke(ctx, invocation) {
    const inputs = CalendarCreateInputs.parse(invocation.inputs);
    let googleAuth: Awaited<ReturnType<typeof ensureAccessToken>> = null;
    try {
      googleAuth = await ensureAccessToken(ctx);
    } catch (err) {
      ctx.logger?.info("google_calendar auth failed; falling back to mock", {
        error: (err as Error).message,
      });
    }

    if (googleAuth) {
      try {
        const endAt =
          inputs.endAt ?? new Date(Date.parse(inputs.startAt) + 60 * 60 * 1000).toISOString();
        const body: Record<string, unknown> = {
          summary: inputs.title,
          start: { dateTime: inputs.startAt, timeZone: googleAuth.timeZone },
          end: { dateTime: endAt, timeZone: googleAuth.timeZone },
          ...(inputs.location && { location: inputs.location }),
          ...(inputs.notes && { description: inputs.notes }),
          ...(inputs.attendees.length > 0 && {
            attendees: inputs.attendees.map((email) => ({ email })),
          }),
        };
        const res = await fetch(
          `${GOOGLE_CAL_BASE}/calendars/${encodeURIComponent(googleAuth.calendarId)}/events`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${googleAuth.accessToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          },
        );
        if (!res.ok) {
          const text = await res.text().catch(() => res.statusText);
          throw new Error(`google_calendar_${res.status}: ${text.slice(0, 200)}`);
        }
        const json = (await res.json()) as { id?: string; start?: { dateTime?: string }; end?: { dateTime?: string } };
        ctx.logger?.info("google_calendar event created", {
          eventId: json.id,
          authorityId: ctx.authorityId,
        });
        return {
          outputs: {
            eventRef: json.id ?? "unknown",
            startAt: json.start?.dateTime ?? inputs.startAt,
            endAt: json.end?.dateTime ?? endAt,
            provider: "google_calendar",
          },
          outcome: "succeeded",
          summary: `Created "${inputs.title}" on Google Calendar at ${inputs.startAt}`,
        };
      } catch (err) {
        ctx.logger?.info("google_calendar create failed; falling back to mock", {
          error: (err as Error).message,
        });
      }
    }

    // Mock fallback — same shape as the earlier phase 0 tool.
    const eventRef = `mock-evt-${Math.random().toString(36).slice(2, 10)}`;
    return {
      outputs: {
        eventRef,
        startAt: inputs.startAt,
        endAt: inputs.endAt,
        provider: "mock",
      },
      outcome: "succeeded",
      summary: `Created "${inputs.title}" at ${inputs.startAt}${
        inputs.location ? ` (${inputs.location})` : ""
      } [mock]`,
    };
  },
};

// ─── calendar.reschedule ────────────────────────────────────────

export const CalendarRescheduleInputs = z.object({
  eventRef: z.string(),
  fromStartAt: z.string().datetime(),
  toStartAt: z.string().datetime(),
  toEndAt: z.string().datetime().optional(),
});
export type CalendarRescheduleInputs = z.infer<typeof CalendarRescheduleInputs>;

export interface CalendarRescheduleOutputs {
  readonly eventRef: string;
  readonly startAt: string;
  readonly endAt: string | undefined;
  readonly provider: "google_calendar" | "mock";
}

export const calendarRescheduleTool: Tool<
  CalendarRescheduleInputs,
  CalendarRescheduleOutputs
> = {
  name: "calendar.reschedule",
  version: "0.2.0",
  sideEffectClass: "write_reversible",
  domain: "calendar",
  actionClass: "calendar.reshuffle",

  async invoke(ctx, invocation) {
    const inputs = CalendarRescheduleInputs.parse(invocation.inputs);
    let googleAuth: Awaited<ReturnType<typeof ensureAccessToken>> = null;
    try {
      googleAuth = await ensureAccessToken(ctx);
    } catch (err) {
      ctx.logger?.info("google_calendar auth failed; falling back to mock", {
        error: (err as Error).message,
      });
    }

    // A mock eventRef (starts with "mock-") can't be patched against
    // Google Calendar — fall straight to the mock reschedule path so
    // we don't emit an obviously-doomed request.
    const canGo =
      googleAuth &&
      !inputs.eventRef.startsWith("mock-") &&
      !inputs.eventRef.startsWith("nod_");

    if (canGo && googleAuth) {
      try {
        const endAt =
          inputs.toEndAt ??
          new Date(Date.parse(inputs.toStartAt) + 60 * 60 * 1000).toISOString();
        const body: Record<string, unknown> = {
          start: { dateTime: inputs.toStartAt, timeZone: googleAuth.timeZone },
          end: { dateTime: endAt, timeZone: googleAuth.timeZone },
        };
        const url = `${GOOGLE_CAL_BASE}/calendars/${encodeURIComponent(googleAuth.calendarId)}/events/${encodeURIComponent(inputs.eventRef)}`;
        const res = await fetch(url, {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${googleAuth.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => res.statusText);
          throw new Error(`google_calendar_${res.status}: ${text.slice(0, 200)}`);
        }
        const json = (await res.json()) as {
          id?: string;
          start?: { dateTime?: string };
          end?: { dateTime?: string };
        };
        return {
          outputs: {
            eventRef: json.id ?? inputs.eventRef,
            startAt: json.start?.dateTime ?? inputs.toStartAt,
            endAt: json.end?.dateTime ?? endAt,
            provider: "google_calendar",
          },
          outcome: "succeeded",
          summary: `Moved event ${inputs.eventRef.slice(0, 12)} to ${inputs.toStartAt} on Google Calendar`,
        };
      } catch (err) {
        ctx.logger?.info("google_calendar reschedule failed; falling back to mock", {
          error: (err as Error).message,
        });
      }
    }

    return {
      outputs: {
        eventRef: inputs.eventRef,
        startAt: inputs.toStartAt,
        endAt: inputs.toEndAt,
        provider: "mock",
      },
      outcome: "succeeded",
      summary: `Moved event ${inputs.eventRef.slice(0, 12)} to ${inputs.toStartAt} [mock]`,
    };
  },
};
