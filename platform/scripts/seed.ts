/* eslint-disable no-console */
import { openDb, householdRepo, identityRepo } from "@atelier/db";

// Development seed: creates one manager and one household, grants
// primary, mints a bearer token, and prints the token to stdout so
// you can paste it into the console's login screen.
//
// Run with:  pnpm --filter @atelier/db exec tsx ../../scripts/seed.ts

const db = openDb();
const identity = identityRepo(db);
const households = householdRepo(db);

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

const { token } = identity.mintToken({
  actorType: "manager",
  actorId: manager.id,
  label: "seed",
});

console.log("");
console.log("bearer token (paste into the console login):");
console.log(token);
