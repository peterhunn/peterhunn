import type { ModelCall, ModelResponse, ModelSpec } from "@atelier/domain";
import type { ProviderAdapter } from "./types.js";

// Mock provider — the fallback used when a real provider's API key is
// not configured, and the source of canned demo output. Real adapters
// live alongside this file; the mockAdapter object exposes invokeMock
// through the ProviderAdapter contract so the registry can treat it
// uniformly.

export const invokeMock = async (
  model: ModelSpec,
  call: ModelCall,
): Promise<Omit<ModelResponse, "modelCallId">> => {
  const inputChars = call.messages.reduce((n, m) => n + m.content.length, 0);
  const inputTokens = Math.max(1, Math.ceil(inputChars / 4));
  const content = cannedResponse(model, call);
  const outputTokens = Math.max(1, Math.ceil(content.length / 4));
  const costUsdEstimated =
    (inputTokens / 1000) * model.costPer1kInputUsd +
    (outputTokens / 1000) * model.costPer1kOutputUsd;
  return {
    modelId: model.id,
    tier: model.tier,
    content,
    toolCalls: [],
    usage: {
      inputTokens,
      outputTokens,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      costUsdEstimated,
    },
    latencyMs: model.latencyP50Ms,
    finishReason: "stop",
    reasons: ["mock_provider"],
  };
};

const cannedResponse = (model: ModelSpec, call: ModelCall): string => {
  const userMsg = call.messages.find((m) => m.role === "user")?.content ?? "";

  switch (call.taskClass) {
    case "inbox.triage":
      return JSON.stringify({
        urgency: guessUrgency(userMsg),
        recipientClass: guessRecipientClass(userMsg),
        requiresReply: /\?|please respond|let me know|confirm/i.test(userMsg) ? "yes" : "no",
        notes: "Auto-triaged (mock provider).",
      });

    case "inbox.extract":
      return JSON.stringify({
        obligations: guessObligations(userMsg),
      });

    case "inbox.draft.reply.low":
      return draftReply(userMsg, "low");

    case "inbox.draft.reply.sensitive":
      return draftReply(userMsg, "sensitive");

    case "calendar.parse":
      return JSON.stringify({ category: "professional" });

    case "admin.renewal.detect":
      return adminRenewalDetect(userMsg);

    case "family.coverage_plan":
      return familyCoveragePlan(userMsg);

    case "travel.plan.multi":
      return travelPlanMulti(userMsg);

    case "travel.match":
      return travelMatch(userMsg);

    case "orchestrator.simple":
    case "orchestrator.cross_domain":
      return JSON.stringify(plannerPlan(userMsg));

    default:
      return `mock:${model.id}:${call.taskClass}`;
  }
};

// Simplified planner heuristic — a real T2/T3 model does the reasoning
// in production; this canned version matches a small number of common
// phrases so the console demo produces plausible plans without any
// external LLM.
const plannerPlan = (
  prompt: string,
): {
  reasoning: string;
  intents: Array<{ kind: string; attrs: Record<string, unknown> }>;
} => {
  const lower = prompt.toLowerCase();
  const intents: Array<{ kind: string; attrs: Record<string, unknown> }> = [];
  const reasons: string[] = [];

  // Trip prompts get decomposed across travel + calendar + household +
  // family so a single natural-language ask exercises the whole
  // orchestrator surface. This is the "London for two weeks in
  // October" bench from ../life-management/models.md.
  const trip = detectTrip(prompt);
  if (trip) {
    intents.push({
      kind: "travel.trip.plan",
      attrs: {
        destination: trip.destination,
        startAt: trip.startAt,
        endAt: trip.endAt,
        notes: prompt.slice(0, 200),
      },
    });
    intents.push({
      kind: "calendar.appointment.create",
      attrs: {
        title: `OOO — ${trip.destination} (travel)`,
        startAt: trip.startAt,
        endAt: trip.endAt,
      },
    });
    intents.push({
      kind: "family.coverage.propose",
      attrs: {
        startAt: trip.startAt,
        endAt: trip.endAt,
        notes: `Coverage during ${trip.destination} trip.`,
      },
    });
    intents.push({
      kind: "household.vendor.schedule",
      attrs: {
        propertyNodeId: "nod_home",
        serviceType: "cleaning",
        notes: "Mid-trip clean.",
      },
    });
    reasons.push(`recognized trip to ${trip.destination}`);
    return { reasoning: reasons.join("; "), intents };
  }

  if (/hvac|plumb|contractor|repair|fence|clean(er|ing)|maintenance/i.test(lower)) {
    const serviceType = /hvac/i.test(lower)
      ? "HVAC"
      : /plumb/i.test(lower)
        ? "plumbing"
        : /clean/i.test(lower)
          ? "cleaning"
          : "service";
    intents.push({
      kind: "household.vendor.schedule",
      attrs: { propertyNodeId: "nod_home", serviceType },
    });
    reasons.push(`recognized household ${serviceType} request`);
  }

  if (/(purchase|buy|order)/i.test(lower)) {
    const amountMatch = /\$(\d[\d,]*)/.exec(prompt);
    const amountUsd = amountMatch ? Number(amountMatch[1]!.replace(/,/g, "")) : 250;
    intents.push({
      kind: "household.vendor.purchase",
      attrs: {
        itemDescription: prompt.slice(0, 80),
        serviceType: "office",
        amountUsd,
      },
    });
    reasons.push(`recognized purchase intent (~$${amountUsd})`);
  }

  if (/meeting|appointment|schedule|book/i.test(lower)) {
    const startAt = nextBusinessAt(15);
    const endAt = new Date(new Date(startAt).getTime() + 60 * 60 * 1000).toISOString();
    intents.push({
      kind: "calendar.appointment.create",
      attrs: {
        title: prompt.slice(0, 60),
        startAt,
        endAt,
      },
    });
    reasons.push("recognized calendar creation");
  }

  if (intents.length === 0) {
    return {
      reasoning:
        "No mapped intents. Real planning requires a live model; the mock provider handles a small set of demo phrases.",
      intents: [],
    };
  }
  return { reasoning: reasons.join("; "), intents };
};

// Canned admin.renewal.detect response. Reads the user message JSON,
// classifies each item on a naive daysUntilExpiry threshold, and
// returns urgency + a short recommended action per type.
const adminRenewalDetect = (userMsg: string): string => {
  type Item = {
    id?: string;
    type?: string;
    title?: string;
    daysUntilExpiry?: number;
  };
  let parsed: { items?: Item[] } = {};
  try {
    parsed = JSON.parse(userMsg) as { items?: Item[] };
  } catch {
    // fall through
  }
  const items = (parsed.items ?? []).map((i) => {
    const d = typeof i.daysUntilExpiry === "number" ? i.daysUntilExpiry : 60;
    const urgency = d < 15 ? "high" : d < 45 ? "normal" : "low";
    const recommendedAction = recommendActionFor(i.type ?? "", i.title ?? "");
    return { id: i.id, urgency, recommendedAction };
  });
  const highs = items.filter((i) => i.urgency === "high").length;
  const summary =
    items.length === 0
      ? "No documents nearing expiry."
      : `${items.length} document${items.length === 1 ? "" : "s"} nearing expiry${
          highs > 0 ? `; ${highs} urgent` : ""
        }.`;
  return JSON.stringify({ summary, items });
};

// Canned family.coverage_plan response. Reads the JSON payload and
// naively assigns routines round-robin across the available staff and
// contacts; if the household has no non-principal coverage, the plan
// surfaces an open question rather than fabricating an assignment.
const familyCoveragePlan = (userMsg: string): string => {
  type Person = { id: string; name: string; role?: string };
  type Payload = {
    members?: Person[];
    staff?: Person[];
    contacts?: Person[];
    window?: { startAt?: string; endAt?: string };
  };
  let payload: Payload = {};
  try {
    payload = JSON.parse(userMsg) as Payload;
  } catch {
    // fall through
  }
  const members = payload.members ?? [];
  const options = [...(payload.staff ?? []), ...(payload.contacts ?? [])];
  const routines = ["morning drop-off", "after-school pickup", "dinner + homework", "bedtime"];

  if (members.length === 0) {
    return JSON.stringify({
      summary: "No members to plan for.",
      assignments: [],
      openQuestions: ["Which members are included in this coverage window?"],
    });
  }

  if (options.length === 0) {
    return JSON.stringify({
      summary: `${members.length} member${members.length === 1 ? "" : "s"} to cover, no staff or contacts on file.`,
      assignments: [],
      openQuestions: [
        "Who should cover routines while the principal is away? No staff or trusted contacts are on file.",
      ],
    });
  }

  const assignments: Array<{
    memberRef: string;
    personRef: string;
    personName: string;
    routine: string;
    note?: string;
  }> = [];
  let cursor = 0;
  for (const m of members) {
    for (const r of routines) {
      const person = options[cursor % options.length]!;
      assignments.push({
        memberRef: m.id,
        personRef: person.id,
        personName: person.name,
        routine: `${m.name} — ${r}`,
      });
      cursor++;
    }
  }

  return JSON.stringify({
    summary: `Coverage draft: ${assignments.length} routines assigned across ${options.length} caregiver${options.length === 1 ? "" : "s"}.`,
    assignments,
    openQuestions: ["Confirm that assigned caregivers are available for the whole window."],
  });
};

// Canned travel.plan.multi — reads destination + dates + travelers +
// preferences and returns a plausible option grid. Real T3 output is
// vastly richer; this is enough to demo the shape.
const travelPlanMulti = (userMsg: string): string => {
  type Payload = {
    destination?: string;
    dates?: { startAt?: string; endAt?: string };
    travelers?: Array<{ id: string; name: string; type: string }>;
    documentConcerns?: Array<{ ref: string; title: string; concern: string }>;
    preferences?: Array<{ scope: string; value: unknown }>;
    notes?: string;
  };
  let payload: Payload = {};
  try {
    payload = JSON.parse(userMsg) as Payload;
  } catch {
    // fall through
  }
  const dest = payload.destination ?? "the destination";
  const startAt = payload.dates?.startAt ?? "TBD";
  const endAt = payload.dates?.endAt ?? "TBD";
  const numTravelers = (payload.travelers ?? []).length;
  const hasChildren = (payload.travelers ?? []).some((t) => t.type === "person.member");
  const preferredAirline = pickPreference(payload.preferences, "airline");
  const preferredHotel = pickPreference(payload.preferences, "hotel");

  const flights = [
    {
      direction: "outbound",
      note: preferredAirline
        ? `Direct with ${preferredAirline}, business cabin.`
        : "Direct, business cabin.",
      price: 3500,
      refundable: false,
      loyaltyMatch: Boolean(preferredAirline),
    },
    {
      direction: "outbound",
      note: "One-stop via a partner alliance; refundable fare.",
      price: 4100,
      refundable: true,
      loyaltyMatch: Boolean(preferredAirline),
    },
    {
      direction: "return",
      note: preferredAirline
        ? `Direct with ${preferredAirline}, business cabin.`
        : "Direct, business cabin.",
      price: 3300,
      refundable: false,
      loyaltyMatch: Boolean(preferredAirline),
    },
  ];
  const hotels = [
    {
      name: preferredHotel ?? "Curated boutique hotel",
      area: `Central ${dest.split(",")[0] ?? dest}`,
      nightly: 750,
      note: "Suite with sitting room; walking distance to meetings.",
      loyaltyMatch: Boolean(preferredHotel),
    },
    {
      name: "Serviced apartment (2BR)",
      area: `Quiet district, ${dest.split(",")[0] ?? dest}`,
      nightly: 950,
      note: hasChildren ? "Two bedrooms + kitchen; better for a family stay." : "Two bedrooms for team + guests.",
      loyaltyMatch: false,
    },
  ];

  const documentNotes = (payload.documentConcerns ?? []).map((d) => `${d.title}: ${d.concern}`);

  return JSON.stringify({
    summary: `Draft plan for ${dest} (${startAt.slice(0, 10)} → ${endAt.slice(0, 10)}) for ${numTravelers} traveler${numTravelers === 1 ? "" : "s"}.`,
    flights,
    hotels,
    groundTransportation:
      "Recommend arranging a car service for arrival + departure and a hotel car for meetings.",
    documentNotes,
    coordinationNeeds: {
      calendar: "Block travel days as OOO; reschedule the recurring team meetings that fall in-window.",
      household: "Place mail on hold; brief cleaner + gardener; pause perishable deliveries.",
      family: hasChildren
        ? "Confirm school pickup + bedtime coverage with nanny + trusted contact."
        : "No family coordination required (adults-only trip).",
      inbox: "Draft an out-of-office reply and forward-of-record note to the assistants team.",
    },
    openQuestions: [
      "Confirm business vs first class threshold for this trip.",
      "Confirm hotel selection: boutique suite vs serviced apartment.",
      documentNotes.length > 0
        ? "Passport(s) expiring inside the six-month post-trip validity window — action needed."
        : "No document concerns detected.",
    ].filter(Boolean),
  });
};

const pickPreference = (
  prefs: Array<{ scope: string; value: unknown }> | undefined,
  key: string,
): string | null => {
  if (!prefs) return null;
  const match = prefs.find((p) => p.scope === key);
  if (!match || typeof match.value !== "object" || match.value === null) return null;
  const v = match.value as Record<string, unknown>;
  const preferred = v[key] ?? v["preferred"] ?? v["value"] ?? v["name"];
  return typeof preferred === "string" ? preferred : null;
};

const travelMatch = (userMsg: string): string => {
  type Payload = {
    origin?: string;
    destination?: string;
    preferences?: Array<{ scope: string; value: unknown }>;
  };
  let payload: Payload = {};
  try {
    payload = JSON.parse(userMsg) as Payload;
  } catch {
    // fall through
  }
  const preferredAirline = pickPreference(payload.preferences, "airline") ?? "American";
  return JSON.stringify({
    summary: `Top 3 candidates for ${payload.origin ?? "?"} → ${payload.destination ?? "?"}.`,
    candidates: [
      {
        airline: preferredAirline,
        cabin: "business",
        price: 3500,
        refundable: false,
        loyaltyMatch: true,
        note: "Preferred airline, direct routing.",
      },
      {
        airline: preferredAirline,
        cabin: "premium_economy",
        price: 1650,
        refundable: true,
        loyaltyMatch: true,
        note: "Refundable and cheaper; longer flight time.",
      },
      {
        airline: "Alliance partner",
        cabin: "business",
        price: 3900,
        refundable: true,
        loyaltyMatch: false,
        note: "Alternative if preferred availability is limited.",
      },
    ],
  });
};

const recommendActionFor = (type: string, title: string): string => {
  const t = title.toLowerCase();
  if (type === "document.identity") {
    if (t.includes("passport")) return "Book passport renewal appointment.";
    if (t.includes("driver") || t.includes("license")) return "Renew driver's license online.";
    return "Renew identity document.";
  }
  if (type === "document.policy") {
    if (t.includes("home")) return "Confirm homeowners auto-renew and rate.";
    if (t.includes("auto") || t.includes("car")) return "Confirm auto policy renewal and rate.";
    return "Confirm policy renewal and rate.";
  }
  if (type === "document.legal") return "Route to counsel for renewal review.";
  return "Handle upcoming renewal.";
};

// Naïve trip detector — matches "we're going / trip / travel to
// <destination> [for <n> <units>] [in <month>]" against the prompt.
// Real planners parse relative dates properly; this is enough for the
// London bench to fire on a fresh clone.
const detectTrip = (
  prompt: string,
): { destination: string; startAt: string; endAt: string } | null => {
  const patterns = [
    /(?:we(?:'re| are)?|i(?:'m| am)?)\s+(?:going|travel(?:ing|ling)?|traveling|heading|off)\s+to\s+([A-Z][A-Za-z\s]+?)\b/,
    /trip\s+to\s+([A-Z][A-Za-z\s]+?)\b/,
    /travel\s+to\s+([A-Z][A-Za-z\s]+?)\b/,
  ];
  let destination: string | null = null;
  for (const p of patterns) {
    const m = p.exec(prompt);
    if (m && m[1]) {
      destination = m[1].trim();
      break;
    }
  }
  if (!destination) return null;

  // Duration: "two weeks", "one week", "10 days" — default two weeks.
  const numberWord: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10,
  };
  let days = 14;
  const wordDur = /\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+(day|days|week|weeks)\b/i.exec(prompt);
  if (wordDur) {
    const n = numberWord[wordDur[1]!.toLowerCase()] ?? 1;
    days = /week/i.test(wordDur[2]!) ? n * 7 : n;
  } else {
    const numDur = /\b(\d+)\s+(days?|weeks?)\b/i.exec(prompt);
    if (numDur) {
      const n = Number(numDur[1]);
      days = /week/i.test(numDur[2]!) ? n * 7 : n;
    }
  }

  // Month: "in October" → next October; default 30 days from now.
  const monthNames = [
    "january","february","march","april","may","june","july","august",
    "september","october","november","december",
  ];
  const monthMatch = /\bin\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.exec(prompt);
  let startAt: Date;
  if (monthMatch) {
    const monthIdx = monthNames.indexOf(monthMatch[1]!.toLowerCase());
    const now = new Date();
    let year = now.getUTCFullYear();
    if (monthIdx <= now.getUTCMonth()) year++;
    startAt = new Date(Date.UTC(year, monthIdx, 5, 0, 0, 0));
  } else {
    startAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  }
  const endAt = new Date(startAt.getTime() + days * 24 * 60 * 60 * 1000);

  return {
    destination,
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
  };
};

const nextBusinessAt = (hourUtc: number): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
};

export const mockAdapter: ProviderAdapter = {
  name: "mock",
  invoke: invokeMock,
};

const guessUrgency = (body: string): "low" | "normal" | "high" => {
  if (/urgent|asap|emergency|immediately/i.test(body)) return "high";
  if (/tomorrow|today|end of day/i.test(body)) return "normal";
  return "low";
};

const guessRecipientClass = (
  body: string,
): "family" | "friend" | "staff" | "vendor" | "employer" | "counsel" | "medical" | "regulator" | "other" => {
  if (/attorney|counsel|legal|lawyer/i.test(body)) return "counsel";
  if (/doctor|physician|medical|clinic|hospital/i.test(body)) return "medical";
  if (/school|principal|teacher|nurse/i.test(body)) return "family";
  if (/invoice|quote|estimate|repair|service call/i.test(body)) return "vendor";
  if (/board|meeting|q\d earnings|deck|memo/i.test(body)) return "employer";
  return "other";
};

const guessObligations = (
  body: string,
): Array<{ title: string; category: string; dueHint?: string }> => {
  const items: Array<{ title: string; category: string; dueHint?: string }> = [];
  const dateHint = /\b(\d{4}-\d{2}-\d{2}|next \w+|this \w+|tomorrow|monday|tuesday|wednesday|thursday|friday)\b/i.exec(
    body,
  );
  if (/rsvp|reply by|respond by/i.test(body)) {
    items.push({
      title: "Reply requested",
      category: "personal",
      ...(dateHint && { dueHint: dateHint[0] }),
    });
  }
  if (/renewal|expires|expiration/i.test(body)) {
    items.push({
      title: "Renewal handling",
      category: "renewal",
      ...(dateHint && { dueHint: dateHint[0] }),
    });
  }
  if (/appointment|schedule|book|reservation/i.test(body)) {
    items.push({
      title: "Appointment to schedule",
      category: "personal",
      ...(dateHint && { dueHint: dateHint[0] }),
    });
  }
  return items;
};

const draftReply = (body: string, kind: "low" | "sensitive"): string => {
  const opening =
    kind === "sensitive"
      ? "Thank you for your note. I'll review carefully and reply promptly."
      : "Thank you for the message.";
  const middle = /appointment|schedule|book/i.test(body)
    ? " I'll confirm timing and be back to you shortly."
    : /invoice|quote|estimate/i.test(body)
      ? " I'll review and confirm next steps."
      : " I'll follow up with a full response soon.";
  return `${opening}${middle}\n\nWith thanks,\nAtelier`;
};
