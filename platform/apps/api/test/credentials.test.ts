import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openDb, householdRepo, identityRepo } from "@atelier/db";
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

  app = buildServer(db);
  await app.ready();
});

afterAll(async () => await app.close());

describe("credentials API", () => {
  it("stores a credential, lists it (metadata only), and revokes it", async () => {
    const store = await app.inject({
      method: "POST",
      url: `/households/${hh}/credentials`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        provider: "google_calendar",
        kind: "oauth2",
        label: "Primary calendar (Alex)",
        credential: {
          access_token: "at-abc",
          refresh_token: "rt-abc",
          client_id: "cid",
          client_secret: "csec",
          calendar_id: "primary",
          time_zone: "UTC",
        },
        scopes: ["https://www.googleapis.com/auth/calendar"],
      },
    });
    expect(store.statusCode).toBe(201);
    const stored: { id: string; provider: string; scopes: string[] } = store.json().credential;
    expect(stored.provider).toBe("google_calendar");
    expect(stored.scopes).toContain("https://www.googleapis.com/auth/calendar");
    // The response body must NOT carry the raw credential blob.
    expect((store.json().credential as Record<string, unknown>).credential).toBeUndefined();

    const list = await app.inject({
      method: "GET",
      url: `/households/${hh}/credentials`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    const items: Array<{ id: string; provider: string }> = list.json().credentials;
    expect(items.some((c) => c.id === stored.id)).toBe(true);

    const revoke = await app.inject({
      method: "POST",
      url: `/households/${hh}/credentials/${stored.id}/revoke`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(revoke.statusCode).toBe(204);
  });
});
