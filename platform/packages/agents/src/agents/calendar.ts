import { z } from "zod";
import type { Agent, AgentContext, AgentTaskOutput, Intent } from "../types.js";

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
      },
    ];
  });
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

  const conflicts = readAppointments(ctx).filter((a) =>
    overlaps(a.startAt, a.endAt, attrs.startAt, attrs.endAt),
  );
  if (conflicts.length > 0) {
    return {
      state: "escalated",
      decisionSummary: `Conflict with ${conflicts.length} existing appointment${
        conflicts.length === 1 ? "" : "s"
      }; escalating for resolution.`,
      outputs: {
        reason: "conflict",
        conflicts: conflicts.map((c) => ({ id: c.id, title: c.title, startAt: c.startAt })),
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

  const all = readAppointments(ctx);
  const target = all.find((a) => a.id === attrs.appointmentNodeId);
  if (!target) {
    return {
      state: "failed",
      errorMessage: `Appointment ${attrs.appointmentNodeId} not found in graph`,
    };
  }

  const otherConflicts = all
    .filter((a) => a.id !== target.id)
    .filter((a) => overlaps(a.startAt, a.endAt, attrs.toStartAt, attrs.toEndAt));
  if (otherConflicts.length > 0) {
    return {
      state: "escalated",
      decisionSummary: `Target time conflicts with ${otherConflicts.length} appointment${
        otherConflicts.length === 1 ? "" : "s"
      }.`,
      outputs: {
        reason: "conflict",
        conflicts: otherConflicts.map((c) => ({ id: c.id, title: c.title, startAt: c.startAt })),
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
