/* eslint-disable no-console */
import {
  openDb,
  householdRepo,
  householdPlaybookRepo,
  identityRepo,
  policyRepo,
  actionRepo,
  graphRepo,
  inboxRepo,
} from "@atelier/db";
import { nowIso, type PolicySpec } from "@atelier/domain";
import { buildPlaybookRegistry, computeNextFireAt } from "@atelier/agents";

// Development seed: creates one manager, one household, primary grant,
// bearer token, and the onboarding starting policy set from
// docs/33-permissions-and-autonomy.md §"Onboarding starting posture".
//
// Run with:  pnpm --filter @atelier/db exec tsx ../../scripts/seed.ts

const db = openDb();
const identity = identityRepo(db);
const households = householdRepo(db);
const policies = policyRepo(db);
const actions = actionRepo(db);
const graph = graphRepo(db);
const inbox = inboxRepo(db);

const email = process.env["SEED_MANAGER_EMAIL"] ?? "seed@atelier.local";
const displayName = process.env["SEED_MANAGER_NAME"] ?? "Seed Manager";
const householdName = process.env["SEED_HOUSEHOLD_NAME"] ?? "Seed Household";

let manager = identity.getManagerByEmail(email);
if (!manager) {
  manager = identity.createManager({ displayName, email });
  console.log(`created manager ${manager.id} (${manager.email})`);
} else {
  console.log(`using existing manager ${manager.id} (${manager.email})`);
}

const household = households.create({ name: householdName, tier: "life" });
console.log(`created household ${household.id} (${household.name})`);

identity.grantHousehold({
  managerId: manager.id,
  householdId: household.id,
  role: "primary",
});

// Onboarding starter policy set — mirrors the table in permissions.md.
const starterPolicies: PolicySpec[] = [
  policy({
    domain: "household",
    actionClass: "vendor.schedule",
    autonomy: "execute",
    label: "Household vendor scheduling (established vendors)",
  }),
  policy({
    domain: "household",
    actionClass: "vendor.purchase",
    autonomy: "execute",
    label: "Household purchase up to $250",
    limits: { perActionUsd: 250 },
    approval: {
      conditions: [{ kind: "amount_gt", threshold: 250 }],
      fallbackApprover: "manager",
    },
  }),
  policy({
    domain: "calendar",
    actionClass: "calendar.reshuffle",
    autonomy: "execute",
    label: "Same-day calendar changes under 30 minutes",
    scope: { window: "same_day" },
    approval: {
      conditions: [{ kind: "attr_eq", key: "cross_day", value: true }],
      fallbackApprover: "manager",
    },
  }),
  policy({
    domain: "calendar",
    actionClass: "calendar.appointment.create",
    autonomy: "execute",
    label: "Appointment creation (calendar defaults)",
  }),
  policy({
    domain: "family",
    actionClass: "restaurant.reserve",
    autonomy: "execute",
    label: "Restaurant reservations up to 6 people",
    approval: {
      conditions: [{ kind: "amount_gt", threshold: 6 }],
      fallbackApprover: "manager",
    },
  }),
  policy({
    domain: "travel",
    actionClass: "flight.book",
    autonomy: "ask",
    label: "Any flight booking (domestic economy default)",
  }),
  policy({
    domain: "communication",
    actionClass: "message.send",
    autonomy: "draft",
    label: "Any outbound customer-voice message",
    approval: {
      conditions: [
        { kind: "attr_in", key: "recipient_class", values: ["counsel", "medical", "employer"] },
      ],
      fallbackApprover: "manager",
    },
  }),
];

for (const spec of starterPolicies) {
  policies.create({
    householdId: household.id,
    spec,
    provenance: {
      source: "customer_direct",
      assertedBy: manager.id,
      confidence: 1,
    },
  });
}
console.log(`seeded ${starterPolicies.length} starter policies`);

// A couple of graph nodes so the household agent has real things to
// reason over. `notes` doubles as a keyword the phase-0 vendor matcher
// looks at when picking a preferred provider.
const now = nowIso();
graph.createNode(household.id, {
  type: "place.property",
  data: {
    label: "Primary residence",
    addressLine1: "123 Elm St",
    city: "Dallas",
    country: "US",
    role: "primary_residence",
  },
  provenance: {
    source: "customer_direct",
    assertedBy: manager.id,
    assertedAt: now,
    confidence: 1,
    status: "confirmed",
  },
});
graph.createNode(household.id, {
  type: "org.vendor",
  data: { name: "Acme HVAC", notes: "HVAC quarterly service" },
  provenance: {
    source: "customer_direct",
    assertedBy: manager.id,
    assertedAt: now,
    confidence: 1,
    status: "confirmed",
  },
});
graph.createNode(household.id, {
  type: "org.vendor",
  data: { name: "Northwest Plumbing", notes: "plumbing on-call" },
  provenance: {
    source: "customer_direct",
    assertedBy: manager.id,
    assertedAt: now,
    confidence: 1,
    status: "confirmed",
  },
});

// Documents with upcoming expiries so admin.renewals.review has
// something to find on first boot. One in ~30 days, one in ~180 days.
const inDays = (n: number): string =>
  new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();
graph.createNode(household.id, {
  type: "document.identity",
  data: {
    title: "Passport — Principal",
    category: "identity",
    expiresAt: inDays(45),
    notes: "US passport, standard renewal.",
  },
  provenance: {
    source: "customer_direct",
    assertedBy: manager.id,
    assertedAt: now,
    confidence: 1,
    status: "confirmed",
  },
});
graph.createNode(household.id, {
  type: "document.policy",
  data: {
    title: "Homeowners insurance",
    category: "policy",
    expiresAt: inDays(30),
    notes: "Annual renewal; auto-renew on file.",
  },
  provenance: {
    source: "customer_direct",
    assertedBy: manager.id,
    assertedAt: now,
    confidence: 1,
    status: "confirmed",
  },
});
// Family scaffolding so family.coverage.propose has something to work
// with: one child, one nanny, one grandparent contact.
graph.createNode(household.id, {
  type: "person.member",
  data: {
    fullName: "Ellie Carrington",
    preferredName: "Ellie",
    relationToPrincipal: "child",
  },
  provenance: {
    source: "customer_direct",
    assertedBy: manager.id,
    assertedAt: now,
    confidence: 1,
    status: "confirmed",
  },
});
graph.createNode(household.id, {
  type: "person.staff",
  data: {
    fullName: "Maria Diaz",
    role: "nanny",
  },
  provenance: {
    source: "customer_direct",
    assertedBy: manager.id,
    assertedAt: now,
    confidence: 1,
    status: "confirmed",
  },
});
graph.createNode(household.id, {
  type: "person.contact",
  data: {
    fullName: "Grandma Rose",
    role: "grandparent",
    affiliation: "family",
  },
  provenance: {
    source: "customer_direct",
    assertedBy: manager.id,
    assertedAt: now,
    confidence: 1,
    status: "confirmed",
  },
});
// Travel preferences so travel.trip.plan can surface loyalty
// matches and the demo's flight options feel real.
graph.createNode(household.id, {
  type: "preference.travel",
  data: {
    scope: "airline",
    value: { airline: "American Airlines", tier: "Executive Platinum" },
  },
  provenance: {
    source: "customer_direct",
    assertedBy: manager.id,
    assertedAt: now,
    confidence: 1,
    status: "confirmed",
  },
});
graph.createNode(household.id, {
  type: "preference.travel",
  data: {
    scope: "hotel",
    value: { hotel: "Rosewood", tier: "Elite" },
  },
  provenance: {
    source: "customer_direct",
    assertedBy: manager.id,
    assertedAt: now,
    confidence: 1,
    status: "confirmed",
  },
});
console.log(
  "seeded property + two vendors + two documents + family + travel preferences",
);

// A sample inbound message so the Inbox agent has something to
// process on first boot.
inbox.create({
  householdId: household.id,
  fromName: "Sam Rodriguez",
  fromAddress: "sam@example.com",
  subject: "Quote for the fence repair",
  body: "Hi — I stopped by yesterday and can start the fence repair on Tuesday morning. Estimate is $1,850 including materials. Please confirm by Friday so I can order the cedar. Thanks, Sam.",
});
inbox.create({
  householdId: household.id,
  fromName: "Ms. Palmer (Ridge School)",
  fromAddress: "office@ridgeschool.example",
  subject: "Signed permission form needed",
  body: "Good afternoon — please return the signed permission form for the field trip on Thursday. Also please confirm that Ellie will be attending. Thanks!",
});
console.log("seeded 2 inbox messages");

// Enable the weekly renewals playbook by default so a fresh clone
// has something proactive scheduled from tick zero. The scheduler
// won't fire it until nextFireAt passes (next Monday 14:00 UTC),
// but the console shows it as enabled with the schedule preview.
const playbookRegistry = buildPlaybookRegistry();
const seededPlaybook = playbookRegistry.get("admin.weekly-renewals-review");
if (seededPlaybook) {
  const playbooks = householdPlaybookRepo(db);
  playbooks.upsert({
    householdId: household.id,
    playbookId: seededPlaybook.id,
    config: seededPlaybook.defaultConfig,
    nextFireAt: computeNextFireAt(seededPlaybook.schedule, new Date()).toISOString(),
  });
  console.log("enabled weekly renewals review playbook");
}

actions.record({
  householdId: household.id,
  agent: "seed",
  agentVersion: "0",
  tool: "seed",
  toolVersion: "0",
  actionClass: "seed.baseline",
  domain: "household" as never,
  inputsHash: "seed",
  outcome: "succeeded",
  summary: "Household onboarded and starter policies applied.",
});

// Seed script mints a 1-year token so a fresh clone doesn't
// need to rotate on day 2. Prod flows use the 90-day default
// and rotate on the console.
const { token, expiresAt: seedExpiresAt } = identity.mintToken({
  actorType: "manager",
  actorId: manager.id,
  label: "seed",
  ttlSeconds: 365 * 24 * 60 * 60,
});

console.log("");
console.log(`bearer token (paste into the console login) — expires ${seedExpiresAt}:`);
console.log(token);

function policy(p: Partial<PolicySpec> & Pick<PolicySpec, "domain" | "actionClass" | "autonomy" | "label">): PolicySpec {
  return {
    effect: "allow",
    kind: "standing",
    subject: "any_principal",
    scope: {},
    limits: {},
    approval: { conditions: [], fallbackApprover: "manager" },
    window: {},
    ...p,
  };
}
