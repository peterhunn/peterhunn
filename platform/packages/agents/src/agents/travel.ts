import { z } from "zod";
import type { Agent, AgentContext, AgentTaskOutput, Intent } from "../types.js";

// Travel agent — the "London for two weeks in October" workflow from
// life-management/models.md and agents.md. Handles the specifically-
// travel piece: flights, hotels, ground, and document checks. Broader
// coordination (calendar, household, family, inbox) happens at the
// planner level — the planner decomposes a trip prompt into a mix of
// intents, of which travel.trip.plan is one.
//
// Two intents so far:
//   travel.trip.plan — full-trip planning: dates + destination →
//     flight options + hotel options + document concerns +
//     coordination reminders. T3 via travel.plan.multi.
//   travel.flight.search — narrower single flight search over a
//     date range. T2 via travel.match.

export const TripPlanAttrs = z.object({
  destination: z.string().min(1),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  travelerRefs: z.array(z.string()).optional(),
  notes: z.string().optional(),
});

export const FlightSearchAttrs = z.object({
  origin: z.string(),
  destination: z.string(),
  departAt: z.string().datetime(),
  returnAt: z.string().datetime().optional(),
  travelerRefs: z.array(z.string()).optional(),
});

const NAME = "travel";
const VERSION = "0.1.0";

const tryParseJson = <T>(s: string): T | null => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
};

interface TravelerRef {
  id: string;
  type: string;
  name: string;
}

interface DocumentConcern {
  ref: string;
  title: string;
  concern: string;
}

export const travelAgent: Agent = {
  name: NAME,
  version: VERSION,

  handles(intent: Intent): boolean {
    return (
      intent.kind === "travel.trip.plan" ||
      intent.kind === "travel.flight.search"
    );
  },

  async handle(intent: Intent, ctx: AgentContext): Promise<AgentTaskOutput> {
    if (intent.kind === "travel.trip.plan") return handleTripPlan(intent, ctx);
    if (intent.kind === "travel.flight.search") return handleFlightSearch(intent, ctx);
    return { state: "failed", errorMessage: `Unsupported intent: ${intent.kind}` };
  },
};

const readTravelers = (ctx: AgentContext, travelerRefs?: readonly string[]): TravelerRef[] => {
  const principals = ctx.graph.listNodes({ type: "person.principal" });
  const members = ctx.graph.listNodes({ type: "person.member" });
  const all: TravelerRef[] = [
    ...principals.map((n) => ({
      id: n.id,
      type: n.type,
      name: String(n.data["fullName"] ?? n.id),
    })),
    ...members.map((n) => ({
      id: n.id,
      type: n.type,
      name: String(n.data["fullName"] ?? n.id),
    })),
  ];
  if (!travelerRefs || travelerRefs.length === 0) return all;
  return all.filter((t) => travelerRefs.includes(t.id));
};

const readTravelPreferences = (ctx: AgentContext): Array<{ scope: string; value: unknown }> => {
  return ctx.graph
    .listNodes({ type: "preference.travel" })
    .map((n) => ({
      scope: String(n.data["scope"] ?? "general"),
      value: n.data["value"],
    }));
};

// Any identity doc whose expiresAt is within 6 months of trip end is
// a red flag — passports typically need to be valid ≥6 months past
// return for many destinations.
const readDocumentConcerns = (
  ctx: AgentContext,
  travelers: readonly TravelerRef[],
  tripEndAt: string,
): DocumentConcern[] => {
  const cutoff = new Date(tripEndAt).getTime() + 6 * 30 * 24 * 60 * 60 * 1000;
  const identityDocs = ctx.graph.listNodes({ type: "document.identity" });
  const concerns: DocumentConcern[] = [];
  for (const d of identityDocs) {
    const expiresAt = d.data["expiresAt"];
    if (typeof expiresAt !== "string") continue;
    const expiresMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresMs)) continue;
    if (expiresMs > cutoff) continue;
    concerns.push({
      ref: d.id,
      title: String(d.data["title"] ?? "Identity document"),
      concern:
        expiresMs < Date.parse(tripEndAt)
          ? `Expires ${new Date(expiresMs).toISOString().slice(0, 10)} — before trip ends.`
          : `Expires ${new Date(expiresMs).toISOString().slice(0, 10)} — inside the 6-month post-trip validity window most destinations require.`,
    });
  }
  // Don't attribute a concern to a specific traveler here — a real
  // implementation would follow `documents` edges from doc → person.
  // For phase 0 we surface all identity docs conservatively.
  void travelers;
  return concerns;
};

const handleTripPlan = async (
  intent: Intent,
  ctx: AgentContext,
): Promise<AgentTaskOutput> => {
  const parsed = TripPlanAttrs.safeParse(intent.attrs);
  if (!parsed.success) {
    return { state: "failed", errorMessage: `Invalid attrs: ${parsed.error.message}` };
  }
  const attrs = parsed.data;
  const travelers = readTravelers(ctx, attrs.travelerRefs);
  if (travelers.length === 0) {
    return {
      state: "escalated",
      decisionSummary: "No travelers found; escalating for manager to identify the party.",
      outputs: { attrs },
    };
  }
  const preferences = readTravelPreferences(ctx);
  const documentConcerns = readDocumentConcerns(ctx, travelers, attrs.endAt);

  const modelRes = await ctx.callModel({
    taskClass: "travel.plan.multi",
    messages: [
      {
        role: "system",
        content:
          "You are the ATELIER Travel agent. Given trip details and household context, produce a proposed plan as JSON: { summary, flights: [{ direction, note, price?, refundable?, loyaltyMatch? }], hotels: [{ name, area, nightly, note, loyaltyMatch? }], groundTransportation?, documentNotes: [string], coordinationNeeds: { calendar: string, household: string, family: string, inbox: string }, openQuestions: [string] }. Reflect the household's travel preferences and any document concerns supplied. Do not invent bookings; present options for a human to choose.",
        cache: true,
      },
      {
        role: "user",
        content: JSON.stringify({
          destination: attrs.destination,
          dates: { startAt: attrs.startAt, endAt: attrs.endAt },
          notes: attrs.notes,
          travelers,
          preferences,
          documentConcerns,
        }),
      },
    ],
    maxOutputTokens: 1200,
  });

  type Plan = {
    summary?: string;
    flights?: Array<Record<string, unknown>>;
    hotels?: Array<Record<string, unknown>>;
    groundTransportation?: string;
    documentNotes?: string[];
    coordinationNeeds?: Record<string, string>;
    openQuestions?: string[];
  };
  const plan =
    tryParseJson<Plan>(modelRes.content) ?? {
      summary: modelRes.content.slice(0, 400),
      flights: [],
      hotels: [],
    };

  const summary =
    plan.summary ??
    `Draft plan for ${attrs.destination} (${attrs.startAt.slice(0, 10)} → ${attrs.endAt.slice(0, 10)}) for ${travelers.length} traveler${travelers.length === 1 ? "" : "s"}.`;

  return {
    state: "completed",
    decisionSummary: summary,
    outputs: {
      destination: attrs.destination,
      dates: { startAt: attrs.startAt, endAt: attrs.endAt },
      travelers,
      preferences,
      documentConcerns,
      plan: {
        summary,
        flights: plan.flights ?? [],
        hotels: plan.hotels ?? [],
        groundTransportation: plan.groundTransportation,
        documentNotes: plan.documentNotes ?? [],
        coordinationNeeds: plan.coordinationNeeds ?? {},
        openQuestions: plan.openQuestions ?? [],
      },
    },
  };
};

const handleFlightSearch = async (
  intent: Intent,
  ctx: AgentContext,
): Promise<AgentTaskOutput> => {
  const parsed = FlightSearchAttrs.safeParse(intent.attrs);
  if (!parsed.success) {
    return { state: "failed", errorMessage: `Invalid attrs: ${parsed.error.message}` };
  }
  const attrs = parsed.data;
  const travelers = readTravelers(ctx, attrs.travelerRefs);
  const preferences = readTravelPreferences(ctx);

  const modelRes = await ctx.callModel({
    taskClass: "travel.match",
    messages: [
      {
        role: "system",
        content:
          "You are the ATELIER Travel agent. Return JSON: { summary, candidates: [{ airline, cabin, price, refundable, loyaltyMatch, note }] }. Reflect the household's travel preferences.",
        cache: true,
      },
      {
        role: "user",
        content: JSON.stringify({
          origin: attrs.origin,
          destination: attrs.destination,
          departAt: attrs.departAt,
          returnAt: attrs.returnAt,
          travelers,
          preferences,
        }),
      },
    ],
    maxOutputTokens: 800,
  });

  type Result = {
    summary?: string;
    candidates?: Array<Record<string, unknown>>;
  };
  const result =
    tryParseJson<Result>(modelRes.content) ?? {
      summary: modelRes.content.slice(0, 300),
      candidates: [],
    };

  return {
    state: "completed",
    decisionSummary: result.summary ?? `${(result.candidates ?? []).length} candidate flight${
      (result.candidates ?? []).length === 1 ? "" : "s"
    } for ${attrs.origin} → ${attrs.destination}.`,
    outputs: {
      request: attrs,
      candidates: result.candidates ?? [],
      preferences,
    },
  };
};
