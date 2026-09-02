import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openDb, householdRepo, identityRepo, auditRepo } from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";
import { buildServer } from "../src/server.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let managerToken: string;
let householdId: HouseholdId;

beforeAll(async () => {
  const db = openDb({ url: ":memory:" });

  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: "../../packages/db/migrations" });

  const identity = identityRepo(db);
  const manager = identity.createManager({
    displayName: "Test Manager",
    email: "test@example.com",
  });
  const minted = identity.mintToken({
    actorType: "manager",
    actorId: manager.id,
    label: "test",
  });
  managerToken = minted.token;

  const hh = householdRepo(db).create({ name: "The Test Household", tier: "life" });
  householdId = hh.id;
  identity.grantHousehold({
    managerId: manager.id,
    householdId: hh.id,
    role: "primary",
  });

  app = buildServer(db);
  await app.ready();

  // Seed an audit event we can read back.
  auditRepo(db).record({
    householdId: hh.id,
    actor: {
      type: "manager",
      id: manager.id,
      displayName: manager.displayName,
      householdIds: [hh.id],
    },
    action: "test.seed",
    resourceType: "household",
    resourceId: hh.id,
  });
});

afterAll(async () => {
  await app.close();
});

describe("public routes", () => {
  it("healthz is reachable without a token", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });
});

describe("auth", () => {
  it("rejects unauthenticated /me", async () => {
    const res = await app.inject({ method: "GET", url: "/me" });
    expect(res.statusCode).toBe(401);
  });

  it("returns the actor for a valid token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${managerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.actor.type).toBe("manager");
    expect(body.actor.householdIds).toContain(householdId);
  });

  it("forbids access to a household the actor has no grant on", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/households/hh_notreal/nodes",
      headers: { authorization: `Bearer ${managerToken}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("audit trail", () => {
  it("records events when a household route is hit", async () => {
    await app.inject({
      method: "GET",
      url: `/households/${householdId}/nodes`,
      headers: { authorization: `Bearer ${managerToken}` },
    });
    const res = await app.inject({
      method: "GET",
      url: `/households/${householdId}/audit`,
      headers: { authorization: `Bearer ${managerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const events: Array<{ action: string }> = res.json().events;
    expect(events.some((e) => e.action === "graph.list_nodes")).toBe(true);
  });
});
