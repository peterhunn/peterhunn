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

describe("people CRUD", () => {
  it("empty list for a fresh household", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/households/${hh}/people`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const b = res.json().people;
    expect(b.principal).toEqual([]);
    expect(b.member).toEqual([]);
    expect(b.staff).toEqual([]);
    expect(b.contact).toEqual([]);
  });

  it("creates a principal + member and lists them under the right bucket", async () => {
    const pRes = await app.inject({
      method: "POST",
      url: `/households/${hh}/people`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        kind: "principal",
        data: {
          fullName: "Alex Rivera",
          preferredName: "Alex",
          emails: ["alex@example.com"],
        },
      },
    });
    expect(pRes.statusCode).toBe(201);
    const p = pRes.json().person;
    expect(p.kind).toBe("principal");
    expect(p.id).toBeDefined();

    const mRes = await app.inject({
      method: "POST",
      url: `/households/${hh}/people`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        kind: "member",
        data: {
          fullName: "Ellie Rivera",
          relationToPrincipal: "child",
        },
      },
    });
    expect(mRes.statusCode).toBe(201);

    const list = (
      await app
        .inject({
          method: "GET",
          url: `/households/${hh}/people`,
          headers: { authorization: `Bearer ${token}` },
        })
        .then((r) => r.json())
    ).people;
    expect(list.principal.length).toBe(1);
    expect(list.member.length).toBe(1);
    expect((list.member[0]!.data as { relationToPrincipal: string }).relationToPrincipal).toBe(
      "child",
    );
  });

  it("400s when required fields are missing or the wrong shape", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/households/${hh}/people`,
      headers: { authorization: `Bearer ${token}` },
      payload: { kind: "member", data: { fullName: "Kid" } }, // missing relationToPrincipal
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_person_data");
  });

  it("patch supersedes the node and returns a new id; old node retires", async () => {
    // Grab the principal we made earlier.
    const before = (
      await app
        .inject({
          method: "GET",
          url: `/households/${hh}/people`,
          headers: { authorization: `Bearer ${token}` },
        })
        .then((r) => r.json())
    ).people.principal[0]!;
    const beforeId = before.id;

    const res = await app.inject({
      method: "PATCH",
      url: `/households/${hh}/people/${beforeId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { data: { pronouns: "they/them" } },
    });
    expect(res.statusCode).toBe(200);
    const after = res.json().person;
    expect(after.id).not.toBe(beforeId);
    expect(after.data.pronouns).toBe("they/them");
    // Merge preserved fullName.
    expect(after.data.fullName).toBe("Alex Rivera");

    // Old node is retired.
    const oldNode = graphRepo(db).getNode(hh, beforeId as never);
    expect(oldNode).toBeNull();
  });

  it("delete retires the node; subsequent list is short one", async () => {
    // Add a staff, delete them, list should not include them.
    const create = await app.inject({
      method: "POST",
      url: `/households/${hh}/people`,
      headers: { authorization: `Bearer ${token}` },
      payload: { kind: "staff", data: { fullName: "Nanny", role: "Nanny" } },
    });
    const id = create.json().person.id;

    const del = await app.inject({
      method: "DELETE",
      url: `/households/${hh}/people/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(204);

    const list = (
      await app
        .inject({
          method: "GET",
          url: `/households/${hh}/people`,
          headers: { authorization: `Bearer ${token}` },
        })
        .then((r) => r.json())
    ).people;
    expect(list.staff.find((s: { id: string }) => s.id === id)).toBeUndefined();
  });

  it("patch on a non-person node type is rejected", async () => {
    // Create an arbitrary non-person node via the graph and try to
    // patch it via the people route.
    const node = graphRepo(db).createNode(hh, {
      type: "place.property",
      data: {
        label: "Home",
        addressLine1: "1 Main St",
        city: "SF",
        country: "US",
        role: "primary_residence",
      },
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
      url: `/households/${hh}/people/${node.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { data: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("not_a_person");
  });
});
