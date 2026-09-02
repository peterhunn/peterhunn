import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  openDb,
  householdRepo,
  identityRepo,
  policyRepo,
  graphRepo,
} from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";
import { buildServer } from "../src/server.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let token: string;
let hh: HouseholdId;

beforeAll(async () => {
  const db = openDb({ url: ":memory:" });
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: "../../packages/db/migrations" });

  const identity = identityRepo(db);
  const m = identity.createManager({ displayName: "M", email: "m@a.b" });
  token = identity.mintToken({ actorType: "manager", actorId: m.id, label: "t" }).token;
  const household = householdRepo(db).create({ name: "H", tier: "life" });
  hh = household.id;
  identity.grantHousehold({ managerId: m.id, householdId: hh, role: "primary" });

  policyRepo(db).create({
    householdId: hh,
    spec: {
      effect: "allow",
      kind: "standing",
      subject: "any_principal",
      domain: "calendar",
      actionClass: "calendar.appointment.create",
      scope: {},
      autonomy: "execute",
      limits: {},
      approval: { conditions: [], fallbackApprover: "manager" },
      window: {},
      label: "Appointment creation",
    },
    provenance: { source: "customer_direct", assertedBy: m.id, confidence: 1 },
  });

  void graphRepo(db);

  app = buildServer(db);
  await app.ready();
});

afterAll(async () => await app.close());

describe("model registry API", () => {
  it("lists registered models", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/models",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const models: Array<{ id: string; tier: string }> = res.json().models;
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.tier === "T1")).toBe(true);
    expect(models.some((m) => m.tier === "T3")).toBe(true);
  });

  it("lists task classes with min tiers", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/models/task-classes",
      headers: { authorization: `Bearer ${token}` },
    });
    const taskClasses: Array<{ id: string; minTier: string }> = res.json().taskClasses;
    expect(taskClasses.some((t) => t.id === "inbox.triage")).toBe(true);
  });

  it("dry-runs the router for a known task class", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/models/select?taskClass=inbox.triage",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.primary.tier).toBe("T1");
    expect(body.resolvedTier).toBe("T1");
  });

  it("records a model call when the calendar agent runs and surfaces it in the budget", async () => {
    const runRes = await app.inject({
      method: "POST",
      url: `/households/${hh}/orchestrator/run`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        kind: "calendar.appointment.create",
        subjectPrincipalId: "any_principal",
        attrs: {
          title: "Router test appt",
          startAt: "2026-10-01T15:00:00.000Z",
          endAt: "2026-10-01T16:00:00.000Z",
        },
        origin: { source: "manager", by: "test" },
      },
    });
    expect(runRes.statusCode).toBe(200);
    expect(runRes.json().run.tasks[0].state).toBe("completed");

    const budget = await app.inject({
      method: "GET",
      url: `/households/${hh}/inference-budget`,
      headers: { authorization: `Bearer ${token}` },
    });
    const body = budget.json();
    expect(body.totalCalls).toBeGreaterThanOrEqual(1);
    expect(body.totalUsd).toBeGreaterThan(0);
    expect(["under", "approaching", "over"]).toContain(body.status);
  });
});
