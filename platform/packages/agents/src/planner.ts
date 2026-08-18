import type { Intent } from "./types.js";

// Planner registry — the set of intents the planner may propose. Each
// entry carries a short description and an example attribute bag so
// the model has enough context to produce well-formed intents. Adding
// a new intent to the system means adding it here as well as
// implementing an agent that handles(...) it.
export interface PlannerIntentSpec {
  readonly kind: string;
  readonly description: string;
  readonly attrsExample: Record<string, unknown>;
}

export const PLANNER_REGISTRY: readonly PlannerIntentSpec[] = [
  {
    kind: "household.vendor.schedule",
    description:
      "Schedule a service visit or appointment with a household vendor (HVAC, plumbing, cleaner, contractor).",
    attrsExample: {
      propertyNodeId: "nod_home",
      serviceType: "HVAC",
      requestedFor: "2026-09-15T10:00:00.000Z",
    },
  },
  {
    kind: "household.vendor.purchase",
    description:
      "Buy something on the customer's behalf via a household vendor (furniture, office supplies, one-off items).",
    attrsExample: {
      itemDescription: "Ergonomic desk chair",
      serviceType: "office",
      amountUsd: 750,
    },
  },
  {
    kind: "calendar.appointment.create",
    description:
      "Put a new appointment on the customer's calendar. Provide startAt / endAt in ISO 8601 UTC.",
    attrsExample: {
      title: "Board meeting",
      startAt: "2026-09-01T15:00:00.000Z",
      endAt: "2026-09-01T16:00:00.000Z",
    },
  },
  {
    kind: "calendar.appointment.reschedule",
    description:
      "Move an existing appointment. Requires the appointment node id from the graph.",
    attrsExample: {
      appointmentNodeId: "nod_meet",
      toStartAt: "2026-09-02T15:00:00.000Z",
      toEndAt: "2026-09-02T16:00:00.000Z",
    },
  },
  {
    kind: "inbox.message.process",
    description:
      "Triage, extract, and draft a reply to a specific inbound message. Use only when the customer references a message that exists in the inbox.",
    attrsExample: {
      messageId: "msg_...",
      fromName: "Sam",
      fromAddress: "sam@example.com",
      subject: "Quote for fence repair",
      body: "…",
    },
  },
];

// A plan is what the planner produces from a prompt. `notes` is a
// short human-readable rationale that shows up in the console.
export interface Plan {
  readonly reasoning: string;
  readonly intents: readonly {
    readonly kind: string;
    readonly attrs: Record<string, unknown>;
    readonly dependsOn?: number;
  }[];
}

// Cheap heuristic — anything that touches >1 domain or reads long is
// cross-domain and deserves T3. Keeps a lightweight orchestrator.simple
// call as the default so most prompts stay cheap.
export const pickPlannerTaskClass = (
  prompt: string,
): "orchestrator.simple" | "orchestrator.cross_domain" => {
  const domains = ["hvac", "plumb", "vendor", "meeting", "calendar", "school", "flight", "hotel", "travel", "reply"];
  const hits = new Set<string>();
  const lower = prompt.toLowerCase();
  for (const d of domains) if (lower.includes(d)) hits.add(d);
  if (hits.size >= 3 || prompt.length > 400) return "orchestrator.cross_domain";
  return "orchestrator.simple";
};

export const plannerSystemPrompt = (): string => {
  const catalog = PLANNER_REGISTRY.map(
    (i) =>
      `- ${i.kind}: ${i.description}\n    example attrs: ${JSON.stringify(i.attrsExample)}`,
  ).join("\n");
  return [
    "You are the ATELIER Orchestrator planner. You decompose a customer message into a small ordered list of intents that specialist agents will execute.",
    "",
    "Return JSON of the shape: { reasoning: string, intents: [ { kind, attrs, dependsOn? } ] }.",
    "Use only the intent kinds listed below; do not invent new kinds.",
    "If the message does not clearly map to any intent, return { reasoning, intents: [] } and explain in reasoning.",
    "",
    "Available intents:",
    catalog,
  ].join("\n");
};

// Robust plan parser — tolerant of extra prose around the JSON, falls
// back to an empty plan rather than throwing. A malformed plan is a
// legitimate outcome the caller should surface, not a crash.
export const parsePlan = (raw: string): Plan => {
  const jsonMatch = raw.match(/\{[\s\S]*\}$/) ?? raw.match(/\{[\s\S]*\}/);
  const candidate = jsonMatch ? jsonMatch[0] : raw;
  try {
    const parsed = JSON.parse(candidate) as {
      reasoning?: string;
      intents?: Array<{ kind?: string; attrs?: Record<string, unknown>; dependsOn?: number }>;
    };
    const intents = (parsed.intents ?? [])
      .filter((i) => typeof i.kind === "string")
      .map((i) => ({
        kind: i.kind as string,
        attrs: (i.attrs ?? {}) as Record<string, unknown>,
        ...(typeof i.dependsOn === "number" && { dependsOn: i.dependsOn }),
      }));
    return { reasoning: parsed.reasoning ?? "", intents };
  } catch {
    return { reasoning: `unparseable plan: ${raw.slice(0, 200)}`, intents: [] };
  }
};

export const isKnownIntentKind = (kind: string): boolean =>
  PLANNER_REGISTRY.some((i) => i.kind === kind);

export const materializeIntent = (
  planItem: { kind: string; attrs: Record<string, unknown> },
  origin: Intent["origin"],
): Intent => ({
  kind: planItem.kind,
  subjectPrincipalId: "any_principal",
  attrs: planItem.attrs,
  origin,
});
