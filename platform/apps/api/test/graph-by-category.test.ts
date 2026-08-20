import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  openDb,
  householdRepo,
  identityRepo,
  graphRepo,
} from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";
import { buildServer } from "../src/server.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let db: ReturnType<typeof openDb>;
let token: string;
let hh: HouseholdId;

beforeAll(async () => {
  db = openDb({ url: ":memory:" });
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: "../../packages/db/migrations" });

  const identity = identityRepo(db);
  const m = identity.createManager({ displayName: "M", email: "m@a.b" });
  token = identity.mintToken({ actorType: "manager", actorId: m.id, label: "t" }).token;
  const household = householdRepo(db).create({ name: "H", tier: "life" });
  hh = household.id;
  identity.grantHousehold({ managerId: m.id, householdId: hh, role: "primary" });

  const g = graphRepo(db);
  const prov = {
    source: "manager_observed" as const,
    assertedBy: "test",
    assertedAt: new Date().toISOString(),
    confidence: 1,
    status: "confirmed" as const,
  };
  g.createNode(hh, {
    type: "person.principal",
    data: { fullName: "Alex", emails: [], phones: [] },
    provenance: prov,
  });
  g.createNode(hh, {
    type: "place.property",
    data: {
      label: "Home",
      addressLine1: "1 Main St",
      city: "SF",
      country: "US",
      role: "primary_residence",
    },
    provenance: prov,
  });
  g.createNode(hh, {
    type: "obligation.deadline",
    data: {
      title: "Passport",
      dueAt: "2026-12-31T00:00:00.000Z",
      category: "renewal",
    },
    provenance: prov,
  });

  app = buildServer(db);
  await app.ready();
});

afterAll(async () => await app.close());

describe("graph by category", () => {
  it("groups every active node into its Accord bucket", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/households/${hh}/graph/by-category`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const b = res.json().byCategory;
    expect(b.participant.length).toBeGreaterThan(0);
    expect(b.asset.length).toBeGreaterThan(0);
    expect(b.event.length).toBeGreaterThan(0);
    expect(b.participant.some((n: { type: string }) => n.type === "person.principal")).toBe(true);
    expect(b.asset.some((n: { type: string }) => n.type === "place.property")).toBe(true);
    expect(b.event.some((n: { type: string }) => n.type === "obligation.deadline")).toBe(true);
  });

  it("returns only one bucket when a category is named", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/households/${hh}/graph/by-category/asset`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.category).toBe("asset");
    expect(body.nodes.every((n: { type: string }) => n.type.startsWith("place.") || n.type.startsWith("asset.") || n.type.startsWith("document."))).toBe(true);
  });

  it("400s an unknown category", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/households/${hh}/graph/by-category/wat`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("unknown_category");
  });
});
