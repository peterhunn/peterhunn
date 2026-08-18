/* eslint-disable no-console */
import {
  openDb,
  householdRepo,
  identityRepo,
  policyRepo,
  actionRepo,
  graphRepo,
} from "@atelier/db";
import { nowIso, type PolicySpec } from "@atelier/domain";

// Development seed: creates one manager, one household, primary grant,
// bearer token, and the onboarding starting policy set from
// ../life-management/permissions.md §"Onboarding starting posture".
//
// Run with:  pnpm --filter @atelier/db exec tsx ../../scripts/seed.ts

const db = openDb();
const identity = identityRepo(db);
const households = householdRepo(db);
const policies = policyRepo(db);
const actions = actionRepo(db);
const graph = graphRepo(db);

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
    scope: { recipient_class: ["counsel", "medical"] },
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
console.log("seeded property + two vendor nodes");

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

const { token } = identity.mintToken({
  actorType: "manager",
  actorId: manager.id,
  label: "seed",
});

console.log("");
console.log("bearer token (paste into the console login):");
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
