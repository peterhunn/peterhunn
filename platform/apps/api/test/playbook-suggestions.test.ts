import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  openDb,
  actionRepo,
  graphRepo,
  householdRepo,
  identityRepo,
  type Db,
} from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";
import { buildServer } from "../src/server.js";
import { computePlaybookSuggestions } from "../src/playbook-suggestions.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let db: Db;
let token: string;
let managerId: string;
let emptyHh: HouseholdId;
let familyHh: HouseholdId;
let docHeavyHh: HouseholdId;
let travelHh: HouseholdId;

const provenance = (assertedBy: string) => ({
  source: "manager_observed" as const,
  assertedBy,
  assertedAt: new Date().toISOString(),
  confidence: 1,
  status: "confirmed" as const,
});

beforeAll(async () => {
  db = openDb({ url: ":memory:" });
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: "../../packages/db/migrations" });

  const identity = identityRepo(db);
  const m = identity.createManager({ displayName: "M", email: "m@a.b" });
  managerId = m.id;
  token = identity.mintToken({
    actorType: "manager",
    actorId: m.id,
    label: "t",
  }).token;

  const mk = (name: string) => {
    const id = householdRepo(db).create({ name, tier: "life" }).id;
    identity.grantHousehold({
      managerId: m.id,
      householdId: id,
      role: "primary",
    });
    return id;
  };

  emptyHh = mk("Empty");
  familyHh = mk("Family");
  docHeavyHh = mk("DocHeavy");
  travelHh = mk("Traveler");

  // Family household: 1 principal + 2 members. Two participants
  // plus is the trigger for family.coverage-check.
  const graph = graphRepo(db);
  graph.createNode(familyHh, {
    type: "person.principal",
    data: { fullName: "Alex" },
    provenance: provenance(managerId),
  });
  graph.createNode(familyHh, {
    type: "person.member",
    data: { fullName: "Kid A", relationToPrincipal: "child" },
    provenance: provenance(managerId),
  });
  graph.createNode(familyHh, {
    type: "person.member",
    data: { fullName: "Kid B", relationToPrincipal: "child" },
    provenance: provenance(managerId),
  });

  // Doc-heavy household: 3 documents across categories.
  const docTypes = [
    { type: "document.identity", category: "identity" },
    { type: "document.legal", category: "legal" },
    { type: "document.policy", category: "policy" },
  ] as const;
  for (const { type, category } of docTypes) {
    graph.createNode(docHeavyHh, {
      type,
      data: { title: `${type} doc`, category },
      provenance: provenance(managerId),
    });
  }

  // Traveler household: 2 recent travel-domain actions.
  const actions = actionRepo(db);
  for (let i = 0; i < 2; i++) {
    actions.record({
      householdId: travelHh,
      agent: "travel.planner",
      agentVersion: "0",
      tool: "travel.trip.plan",
      toolVersion: "0",
      actionClass: "travel.trip.plan",
      domain: "travel",
      inputsHash: `h${i}`,
      outcome: "succeeded",
      summary: `trip ${i}`,
    });
  }

  app = buildServer(db);
  await app.ready();
});

afterAll(async () => await app.close());

describe("playbook auto-enable suggestions", () => {
  it("no suggestions for an empty household — no signals fire", () => {
    const s = computePlaybookSuggestions(db, emptyHh);
    expect(s).toEqual([]);
  });

  it("family.coverage-check surfaces when the household has ≥2 people", () => {
    const s = computePlaybookSuggestions(db, familyHh);
    const family = s.find((x) => x.playbookId === "family.coverage-check");
    expect(family).toBeDefined();
    expect(family!.signal.unit).toBe("people");
    expect(family!.signal.count).toBe(3);
    expect(family!.reason).toContain("3 people");
    // Neither of the other playbooks matches on a bare family (no
    // docs, no travel history).
    expect(
      s.find((x) => x.playbookId === "admin.weekly-renewals-review"),
    ).toBeUndefined();
    expect(s.find((x) => x.playbookId === "travel.prep-sweep")).toBeUndefined();
  });

  it("admin.weekly-renewals-review surfaces when the household has ≥3 documents", () => {
    const s = computePlaybookSuggestions(db, docHeavyHh);
    const renewals = s.find(
      (x) => x.playbookId === "admin.weekly-renewals-review",
    );
    expect(renewals).toBeDefined();
    expect(renewals!.signal.count).toBe(3);
    expect(renewals!.reason).toContain("3 documents");
  });

  it("travel.prep-sweep surfaces when the household has ≥2 travel-domain actions", () => {
    const s = computePlaybookSuggestions(db, travelHh);
    const travel = s.find((x) => x.playbookId === "travel.prep-sweep");
    expect(travel).toBeDefined();
    expect(travel!.signal.count).toBe(2);
    expect(travel!.reason).toContain("2 travel actions");
  });

  it("enabling a suggested playbook drops it from the list on next compute", async () => {
    const before = computePlaybookSuggestions(db, familyHh);
    expect(
      before.find((x) => x.playbookId === "family.coverage-check"),
    ).toBeDefined();

    // Enable via the existing PUT route — no new adopt endpoint
    // needed for playbooks.
    const enableRes = await app.inject({
      method: "PUT",
      url: `/households/${familyHh}/playbooks/family.coverage-check`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(enableRes.statusCode).toBe(200);

    const after = computePlaybookSuggestions(db, familyHh);
    expect(
      after.find((x) => x.playbookId === "family.coverage-check"),
    ).toBeUndefined();
  });

  it("HTTP: GET returns suggestions in the wire shape", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/households/${docHeavyHh}/playbooks/suggestions`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body: {
      suggestions: Array<{
        playbookId: string;
        name: string;
        signal: { count: number; threshold: number; unit: string };
      }>;
    } = res.json();
    const renewals = body.suggestions.find(
      (s) => s.playbookId === "admin.weekly-renewals-review",
    );
    expect(renewals).toBeDefined();
    expect(renewals!.signal.count).toBeGreaterThanOrEqual(
      renewals!.signal.threshold,
    );
  });

  it("windowDays override is accepted by the endpoint", async () => {
    // Travel actions were seeded with real timestamps; a 1-day
    // window may or may not include them depending on ordering,
    // but the endpoint must at least parse the query and return
    // a valid array.
    const res = await app.inject({
      method: "GET",
      url: `/households/${travelHh}/playbooks/suggestions?windowDays=1`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().suggestions)).toBe(true);
  });
});
