import { z } from "zod";
import type { Tool } from "../types.js";

// calendar.create — write_reversible. In production this would call the
// customer's calendar provider (Google, Microsoft, iCloud) via a
// delegated grant; here it returns a synthetic event id so the graph
// writeback and action ledger see the full shape.

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
}

export const calendarCreateTool: Tool<CalendarCreateInputs, CalendarCreateOutputs> = {
  name: "calendar.create",
  version: "0.1.0",
  sideEffectClass: "write_reversible",
  domain: "calendar",
  actionClass: "calendar.appointment.create",

  async invoke(ctx, invocation) {
    const inputs = CalendarCreateInputs.parse(invocation.inputs);
    const eventRef = `mock-evt-${Math.random().toString(36).slice(2, 10)}`;
    ctx.logger?.info("calendar.create invoked", {
      title: inputs.title,
      startAt: inputs.startAt,
      authorityId: ctx.authorityId,
    });
    return {
      outputs: {
        eventRef,
        startAt: inputs.startAt,
        endAt: inputs.endAt,
      },
      outcome: "succeeded",
      summary: `Created "${inputs.title}" at ${inputs.startAt}${
        inputs.location ? ` (${inputs.location})` : ""
      }`,
    };
  },
};

// calendar.reschedule — moves an existing appointment. Action class
// matches the seeded `calendar.reshuffle` policy (execute for same-day,
// escalates on cross_day via an escalation condition).

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
}

export const calendarRescheduleTool: Tool<
  CalendarRescheduleInputs,
  CalendarRescheduleOutputs
> = {
  name: "calendar.reschedule",
  version: "0.1.0",
  sideEffectClass: "write_reversible",
  domain: "calendar",
  actionClass: "calendar.reshuffle",

  async invoke(ctx, invocation) {
    const inputs = CalendarRescheduleInputs.parse(invocation.inputs);
    ctx.logger?.info("calendar.reschedule invoked", {
      eventRef: inputs.eventRef,
      from: inputs.fromStartAt,
      to: inputs.toStartAt,
      authorityId: ctx.authorityId,
    });
    return {
      outputs: {
        eventRef: inputs.eventRef,
        startAt: inputs.toStartAt,
        endAt: inputs.toEndAt,
      },
      outcome: "succeeded",
      summary: `Moved event ${inputs.eventRef.slice(0, 12)} to ${inputs.toStartAt}`,
    };
  },
};
