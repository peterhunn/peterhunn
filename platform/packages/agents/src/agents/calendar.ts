import { z } from "zod";
import type { Agent, AgentContext, AgentTaskOutput, Intent } from "../types.js";
import { listGoogleCalendarEvents } from "../tools/calendar.js";

// Calendar agent — handles appointment create and reschedule intents.
// Reads existing `obligation.appointment` nodes to detect conflicts
// before proposing, and writes the resulting appointment back to the
// graph on success. Conflict detection is intentionally simple in
// phase 0: any overlap in [startAt, endAt) counts.

export const CreateAppointmentAttrs = z.object({
  title: z.string(),
  startAt: z.string().datetime(),
  endAt: z.string().datetime().optional(),
  location: z.string().optional(),
  attendees: z.array(z.string()).optional(),
  notes: z.string().optional(),
});

export const RescheduleAppointmentAttrs = z.object({
  appointmentNodeId: z.string(),
  toStartAt: z.string().datetime(),
  toEndAt: z.string().datetime().optional(),
});

const NAME = "calendar";
const VERSION = "0.1.0";

type Appointment = {
  id: string;
  title: string;
  startAt: string;
  endAt: string | undefined;
  eventRef: string | undefined;
  source: "graph" | "google_calendar";
};

const readAppointments = (ctx: AgentContext): Appointment[] => {
  return ctx.graph.listNodes({ type: "obligation.appointment" }).flatMap((n) => {
    const startAt = String(n.data["startAt"] ?? "");
    if (!startAt) return [];
    const endAtVal = n.data["endAt"];
    return [
      {
        id: n.id,
        title: String(n.data["title"] ?? ""),
        startAt,
        endAt: typeof endAtVal === "string" ? endAtVal : undefined,
        eventRef:
          typeof n.data["eventRef"] === "string"
            ? String(n.data["eventRef"])
            : undefined,
        source: "graph",
      },
    ];
  });
};

// Merge graph appointments with a live Google Calendar read for a
// window. Dedupe by eventRef so a graph node that carries its
// Google event id doesn't double-count. Falls through to graph only
// when no google_calendar credential is stored, and on any live-read
// failure so we never silently skip conflict detection.
const readAppointmentsInWindow = async (
  ctx: AgentContext,
  window: { startAtMs: number; endAtMs: number },
): Promise<{
  appointments: Appointment[];
  liveConsulted: boolean;
  liveError: string | null;
}> => {
  const graphAppts = readAppointments(ctx);
  const paddedMin = new Date(window.startAtMs - 24 * 60 * 60 * 1000).toISOString();
  const paddedMax = new Date(window.endAtMs + 24 * 60 * 60 * 1000).toISOString();
  let live: Awaited<ReturnType<typeof listGoogleCalendarEvents>> = null;
  let liveError: string | null = null;
  try {
    // Present the agent context as a ToolContext (the fields
    // listGoogleCalendarEvents reads — readCredential and logger —
    // are already on AgentContext).
    live = await listGoogleCalendarEvents(
      {
        householdId: ctx.householdId,
        authorityId: undefined,
        proposedBy: { actor: "calendar_agent", version: "0.1.0" },
        readCredential: ctx.readCredential,
        logger: ctx.logger,
      },
      { timeMin: paddedMin, timeMax: paddedMax },
    );
  } catch (err) {
    liveError = (err as Error).message;
  }

  if (!live) {
    return { appointments: graphAppts, liveConsulted: false, liveError };
  }

  const known = new Set(graphAppts.map((a) => a.eventRef).filter((r): r is string => Boolean(r)));
  const liveAppts: Appointment[] = live
    .filter((e) => !known.has(e.eventRef))
    .map((e) => ({
      id: e.id,
      title: e.title,
      startAt: e.startAt,
      endAt: e.endAt ?? undefined,
      eventRef: e.eventRef,
      source: "google_calendar",
    }));
  return {
    appointments: [...graphAppts, ...liveAppts],
    liveConsulted: true,
    liveError: null,
  };
};

const overlaps = (
  aStart: string,
  aEnd: string | undefined,
  bStart: string,
  bEnd: string | undefined,
): boolean => {
  const aS = new Date(aStart).getTime();
  const aE = aEnd ? new Date(aEnd).getTime() : aS + 60 * 60 * 1000;
  const bS = new Date(bStart).getTime();
  const bE = bEnd ? new Date(bEnd).getTime() : bS + 60 * 60 * 1000;
  return aS < bE && bS < aE;
};

const sameDay = (a: string, b: string): boolean =>
  a.slice(0, 10) === b.slice(0, 10);

export const calendarAgent: Agent = {
  name: NAME,
  version: VERSION,

  handles(intent: Intent): boolean {
    return (
      intent.kind === "calendar.appointment.create" ||
      intent.kind === "calendar.appointment.reschedule"
    );
  },

  async handle(intent: Intent, ctx: AgentContext): Promise<AgentTaskOutput> {
    if (intent.kind === "calendar.appointment.create") {
      // A T1 model touch so this agent exercises the router + budget.
      // Real production usage would parse a free-text "book my dentist
      // next Tuesday at 3" into a structured intent; here we run a
      // trivial classification purely to record a model call and let
      // the budget bar reflect activity.
      try {
        await ctx.callModel({
          taskClass: "calendar.parse",
          messages: [
            {
              role: "system",
              content:
                "Classify a calendar intent into one of: personal, professional, family. Return one word.",
            },
            {
              role: "user",
              content: JSON.stringify(intent.attrs),
            },
          ],
          maxOutputTokens: 8,
        });
      } catch (err) {
        ctx.logger.info("router callModel failed (non-fatal)", {
          message: (err as Error).message,
        });
      }
      return handleCreate(intent, ctx);
    }
    if (intent.kind === "calendar.appointment.reschedule") {
      return handleReschedule(intent, ctx);
    }
    return { state: "failed", errorMessage: `Unsupported intent: ${intent.kind}` };
  },
};

async function handleCreate(
  intent: Intent,
  ctx: AgentContext,
): Promise<AgentTaskOutput> {
  const parsed = CreateAppointmentAttrs.safeParse(intent.attrs);
  if (!parsed.success) {
    return { state: "failed", errorMessage: `Invalid intent attrs: ${parsed.error.message}` };
  }
  const attrs = parsed.data;

  const startAtMs = Date.parse(attrs.startAt);
  const endAtMs = attrs.endAt ? Date.parse(attrs.endAt) : startAtMs + 60 * 60 * 1000;
  const { appointments, liveConsulted } = await readAppointmentsInWindow(ctx, {
    startAtMs,
    endAtMs,
  });
  const conflicts = appointments.filter((a) =>
    overlaps(a.startAt, a.endAt, attrs.startAt, attrs.endAt),
  );
  if (conflicts.length > 0) {
    return {
      state: "escalated",
      decisionSummary: `Conflict with ${conflicts.length} existing appointment${
        conflicts.length === 1 ? "" : "s"
      }${liveConsulted ? " (graph + Google Calendar)" : ""}; escalating for resolution.`,
      outputs: {
        reason: "conflict",
        liveConsulted,
        conflicts: conflicts.map((c) => ({
          id: c.id,
          title: c.title,
          startAt: c.startAt,
          source: c.source,
        })),
      },
    };
  }

  const result = await ctx.invokeTool<
    Record<string, unknown>,
    { eventRef: string; startAt: string; endAt: string | undefined }
  >(
    "calendar.create",
    {
      title: attrs.title,
      startAt: attrs.startAt,
      ...(attrs.endAt !== undefined && { endAt: attrs.endAt }),
      ...(attrs.location !== undefined && { location: attrs.location }),
      attendees: attrs.attendees ?? [],
      ...(attrs.notes !== undefined && { notes: attrs.notes }),
    },
    { summary: `Create "${attrs.title}"` },
  );

  const decision = result.decision.decision;
  if (decision === "shelved") {
    return {
      state: "shelved",
      decisionSummary: "Household is frozen; action shelved.",
      outputs: { decision: result.decision },
    };
  }
  if (decision === "denied") {
    return {
      state: "rejected",
      decisionSummary: `Denied: ${result.decision.reasons.join(", ")}`,
      outputs: { decision: result.decision },
    };
  }
  if (decision === "customer_approval" || decision === "manager_review") {
    return {
      state: "escalated",
      decisionSummary: `Awaiting ${decision.replace("_", " ")}${
        result.approvalId ? ` (approval ${result.approvalId})` : ""
      }.`,
      outputs: { decision: result.decision, ...(result.approvalId && { approvalId: result.approvalId }) },
    };
  }
  if (decision !== "auto_execute" || !result.action || result.action.outcome !== "succeeded") {
    return {
      state: "failed",
      decisionSummary: `Tool did not succeed: ${result.action?.outcome ?? "no_action"}`,
      outputs: { decision: result.decision, action: result.action },
    };
  }

  const written = ctx.writer.writeNode({
    type: "obligation.appointment",
    data: {
      title: attrs.title,
      startAt: attrs.startAt,
      ...(attrs.endAt !== undefined && { endAt: attrs.endAt }),
      ...(attrs.location !== undefined && { location: attrs.location }),
      ...(attrs.notes !== undefined && { notes: attrs.notes }),
      eventRef: result.outputs?.eventRef,
    },
    status: "confirmed",
    confidence: 1,
    sourceRef: result.action.id,
  });

  return {
    state: "completed",
    decisionSummary: result.action.summary,
    outputs: {
      decision: result.decision,
      action: result.action,
      appointment: { id: written.id, ...result.outputs },
    },
  };
}

async function handleReschedule(
  intent: Intent,
  ctx: AgentContext,
): Promise<AgentTaskOutput> {
  const parsed = RescheduleAppointmentAttrs.safeParse(intent.attrs);
  if (!parsed.success) {
    return { state: "failed", errorMessage: `Invalid intent attrs: ${parsed.error.message}` };
  }
  const attrs = parsed.data;

  const graphAll = readAppointments(ctx);
  const target = graphAll.find((a) => a.id === attrs.appointmentNodeId);
  if (!target) {
    return {
      state: "failed",
      errorMessage: `Appointment ${attrs.appointmentNodeId} not found in graph`,
    };
  }

  const toStartMs = Date.parse(attrs.toStartAt);
  const toEndMs = attrs.toEndAt ? Date.parse(attrs.toEndAt) : toStartMs + 60 * 60 * 1000;
  const { appointments, liveConsulted } = await readAppointmentsInWindow(ctx, {
    startAtMs: toStartMs,
    endAtMs: toEndMs,
  });

  const otherConflicts = appointments
    .filter((a) => a.id !== target.id && a.eventRef !== target.eventRef)
    .filter((a) => overlaps(a.startAt, a.endAt, attrs.toStartAt, attrs.toEndAt));
  if (otherConflicts.length > 0) {
    return {
      state: "escalated",
      decisionSummary: `Target time conflicts with ${otherConflicts.length} appointment${
        otherConflicts.length === 1 ? "" : "s"
      }${liveConsulted ? " (graph + Google Calendar)" : ""}.`,
      outputs: {
        reason: "conflict",
        liveConsulted,
        conflicts: otherConflicts.map((c) => ({
          id: c.id,
          title: c.title,
          startAt: c.startAt,
          source: c.source,
        })),
      },
    };
  }

  const crossDay = !sameDay(target.startAt, attrs.toStartAt);

  const result = await ctx.invokeTool<
    Record<string, unknown>,
    { eventRef: string; startAt: string; endAt: string | undefined }
  >(
    "calendar.reschedule",
    {
      eventRef: target.eventRef ?? target.id,
      fromStartAt: target.startAt,
      toStartAt: attrs.toStartAt,
      ...(attrs.toEndAt !== undefined && { toEndAt: attrs.toEndAt }),
    },
    {
      summary: `Move "${target.title}" from ${target.startAt} to ${attrs.toStartAt}`,
      attrs: { cross_day: crossDay, window: "same_day" },
    },
  );

  const decision = result.decision.decision;
  if (decision === "shelved") {
    return {
      state: "shelved",
      decisionSummary: "Household is frozen; action shelved.",
      outputs: { decision: result.decision },
    };
  }
  if (decision === "denied") {
    return {
      state: "rejected",
      decisionSummary: `Denied: ${result.decision.reasons.join(", ")}`,
      outputs: { decision: result.decision },
    };
  }
  if (decision === "customer_approval" || decision === "manager_review") {
    return {
      state: "escalated",
      decisionSummary: `Awaiting ${decision.replace("_", " ")}${
        result.approvalId ? ` (approval ${result.approvalId})` : ""
      }.`,
      outputs: { decision: result.decision, ...(result.approvalId && { approvalId: result.approvalId }) },
    };
  }
  if (decision !== "auto_execute" || !result.action || result.action.outcome !== "succeeded") {
    return {
      state: "failed",
      decisionSummary: `Tool did not succeed: ${result.action?.outcome ?? "no_action"}`,
      outputs: { decision: result.decision, action: result.action },
    };
  }

  const written = ctx.writer.writeNode({
    type: "obligation.appointment",
    data: {
      title: target.title,
      startAt: attrs.toStartAt,
      ...(attrs.toEndAt !== undefined && { endAt: attrs.toEndAt }),
      eventRef: target.eventRef,
      supersedes: target.id,
    },
    status: "confirmed",
    confidence: 1,
    sourceRef: result.action.id,
  });
  ctx.writer.supersedeNode(target.id, written.id);

  return {
    state: "completed",
    decisionSummary: result.action.summary,
    outputs: {
      decision: result.decision,
      action: result.action,
      appointment: { id: written.id, supersedes: target.id, ...result.outputs },
    },
  };
}
