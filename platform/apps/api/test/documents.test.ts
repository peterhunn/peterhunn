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

describe("documents CRUD", () => {
  it("empty buckets on fresh household", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/households/${hh}/documents`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const d = res.json().documents;
    for (const sub of ["identity", "legal", "policy", "record", "receipt"] as const) {
      expect(d[sub]).toEqual([]);
    }
  });

  it("creates an identity + policy doc under the right subcategory node type", async () => {
    const passport = await app.inject({
      method: "POST",
      url: `/households/${hh}/documents`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        subcategory: "identity",
        data: {
          title: "US Passport",
          category: "identity",
          expiresAt: "2029-05-01T00:00:00Z",
          notes: "renewal cycle 10y",
        },
      },
    });
    expect(passport.statusCode).toBe(201);
    expect(passport.json().document.subcategory).toBe("identity");

    const homeowners = await app.inject({
      method: "POST",
      url: `/households/${hh}/documents`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        subcategory: "policy",
        data: {
          title: "Homeowners insurance",
          category: "policy",
          expiresAt: "2026-11-15T00:00:00Z",
        },
      },
    });
    expect(homeowners.statusCode).toBe(201);

    const list = (
      await app
        .inject({
          method: "GET",
          url: `/households/${hh}/documents`,
          headers: { authorization: `Bearer ${token}` },
        })
        .then((r) => r.json())
    ).documents;
    expect(list.identity.length).toBe(1);
    expect(list.policy.length).toBe(1);
    expect((list.identity[0]!.data as { title: string }).title).toBe("US Passport");
  });

  it("400s missing required title", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/households/${hh}/documents`,
      headers: { authorization: `Bearer ${token}` },
      payload: { subcategory: "record", data: { category: "record" } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_document_data");
  });

  it("patch supersedes and preserves untouched fields", async () => {
    const list = (
      await app
        .inject({
          method: "GET",
          url: `/households/${hh}/documents`,
          headers: { authorization: `Bearer ${token}` },
        })
        .then((r) => r.json())
    ).documents;
    const passport = list.identity[0]!;

    const res = await app.inject({
      method: "PATCH",
      url: `/households/${hh}/documents/${passport.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { data: { storedAt: "https://vault.example/passport-alex.pdf" } },
    });
    expect(res.statusCode).toBe(200);
    const after = res.json().document;
    expect(after.id).not.toBe(passport.id);
    expect(after.data.storedAt).toBe("https://vault.example/passport-alex.pdf");
    expect(after.data.title).toBe("US Passport");

    const old = graphRepo(db).getNode(hh, passport.id as never);
    expect(old).toBeNull();
  });

  it("PATCH on a non-document node is rejected", async () => {
    const node = graphRepo(db).createNode(hh, {
      type: "person.principal",
      data: { fullName: "Alex", emails: [], phones: [] },
      provenance: {
        source: "manager_observed",
        assertedBy: "test",
        assertedAt: new Date().toISOString(),
        confidence: 1,
        status: "confirmed",
      },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/households/${hh}/documents/${node.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { data: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("not_a_document");
  });

  it("delete retires the node", async () => {
    const create = await app.inject({
      method: "POST",
      url: `/households/${hh}/documents`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        subcategory: "receipt",
        data: { title: "Contractor invoice", category: "receipt" },
      },
    });
    const id = create.json().document.id;
    const del = await app.inject({
      method: "DELETE",
      url: `/households/${hh}/documents/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(204);
    const list = (
      await app
        .inject({
          method: "GET",
          url: `/households/${hh}/documents`,
          headers: { authorization: `Bearer ${token}` },
        })
        .then((r) => r.json())
    ).documents;
    expect(list.receipt.find((d: { id: string }) => d.id === id)).toBeUndefined();
  });
});
