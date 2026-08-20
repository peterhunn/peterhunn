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

  app = buildServer(db);
  await app.ready();
});

afterAll(async () => await app.close());

describe("assets CRUD", () => {
  it("empty buckets on a fresh household", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/households/${hh}/assets`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const b = res.json().assets;
    expect(b.property).toEqual([]);
    expect(b.vehicle).toEqual([]);
    expect(b.equipment).toEqual([]);
    expect(b.membership).toEqual([]);
    expect(b.pet).toEqual([]);
  });

  it("creates a property, vehicle, and pet under the right buckets", async () => {
    await app.inject({
      method: "POST",
      url: `/households/${hh}/assets`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        kind: "property",
        data: {
          label: "Main house",
          addressLine1: "1 Main St",
          city: "SF",
          country: "US",
          role: "primary_residence",
        },
      },
    });
    await app.inject({
      method: "POST",
      url: `/households/${hh}/assets`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        kind: "vehicle",
        data: { label: "Family SUV", make: "Volvo", model: "XC90", year: 2023 },
      },
    });
    await app.inject({
      method: "POST",
      url: `/households/${hh}/assets`,
      headers: { authorization: `Bearer ${token}` },
      payload: { kind: "pet", data: { name: "Toby", species: "dog", breed: "labrador" } },
    });

    const list = (
      await app
        .inject({
          method: "GET",
          url: `/households/${hh}/assets`,
          headers: { authorization: `Bearer ${token}` },
        })
        .then((r) => r.json())
    ).assets;
    expect(list.property.length).toBe(1);
    expect(list.vehicle.length).toBe(1);
    expect(list.pet.length).toBe(1);
    expect((list.vehicle[0]!.data as { year: number }).year).toBe(2023);
  });

  it("400s missing required fields", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/households/${hh}/assets`,
      headers: { authorization: `Bearer ${token}` },
      payload: { kind: "vehicle", data: { label: "Missing make/model" } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_asset_data");
  });

  it("patch supersedes the node and preserves untouched fields", async () => {
    const list = (
      await app
        .inject({
          method: "GET",
          url: `/households/${hh}/assets`,
          headers: { authorization: `Bearer ${token}` },
        })
        .then((r) => r.json())
    ).assets;
    const vehicle = list.vehicle[0]!;

    const res = await app.inject({
      method: "PATCH",
      url: `/households/${hh}/assets/${vehicle.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { data: { vin: "WVWZZZ1JZ3W386752" } },
    });
    expect(res.statusCode).toBe(200);
    const after = res.json().asset;
    expect(after.id).not.toBe(vehicle.id);
    expect(after.data.vin).toBe("WVWZZZ1JZ3W386752");
    // Merge preserved the earlier fields.
    expect(after.data.make).toBe("Volvo");
    expect(after.data.year).toBe(2023);

    const old = graphRepo(db).getNode(hh, vehicle.id as never);
    expect(old).toBeNull();
  });

  it("delete retires the node", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/households/${hh}/assets`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        kind: "membership",
        data: { label: "Country club", organization: "Bay Country Club" },
      },
    });
    const id = created.json().asset.id;
    const del = await app.inject({
      method: "DELETE",
      url: `/households/${hh}/assets/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(204);
    const list = (
      await app
        .inject({
          method: "GET",
          url: `/households/${hh}/assets`,
          headers: { authorization: `Bearer ${token}` },
        })
        .then((r) => r.json())
    ).assets;
    expect(
      list.membership.find((m: { id: string }) => m.id === id),
    ).toBeUndefined();
  });

  it("PATCH on a non-asset node type is rejected", async () => {
    const node = graphRepo(db).createNode(hh, {
      type: "person.principal",
      data: { fullName: "Alex", emails: [], phones: [] },
      provenance: {
        source: "manager_observed",
        assertedBy: "test:seed",
        assertedAt: new Date().toISOString(),
        confidence: 1,
        status: "confirmed",
      },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/households/${hh}/assets/${node.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { data: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("not_an_asset");
  });
});
