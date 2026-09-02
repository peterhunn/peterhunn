import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  openDb,
  contactEndpointRepo,
  householdRepo,
  identityRepo,
} from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";
import { buildServer } from "../src/server.js";
import type { FastifyInstance } from "fastify";

// Rate limiting keys on the bearer token when present, IP
// otherwise. Public webhooks have a per-route override with a
// stricter cap (60/min per IP). The default cap is high enough
// that a normal test file's handful of requests never trips it —
// but this file's whole point is to trip it, so we lower the
// default via env and re-build.

let db: ReturnType<typeof openDb>;
let app: FastifyInstance;
let token: string;
let hh: HouseholdId;

beforeAll(async () => {
  db = openDb({ url: ":memory:" });
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: "../../packages/db/migrations" });

  const identity = identityRepo(db);
  const m = identity.createManager({ displayName: "M", email: "m@a.b" });
  token = identity.mintToken({ actorType: "manager", actorId: m.id, label: "t" }).token;
  hh = householdRepo(db).create({ name: "H", tier: "life" }).id;
  identity.grantHousehold({ managerId: m.id, householdId: hh, role: "primary" });
  contactEndpointRepo(db).create({
    householdId: hh,
    channel: "sms",
    address: "+14155550000",
  });

  // Cap the global default at 5/window so the loop below can
  // trip it without shipping thousands of requests. The webhook
  // route's own limit (60/min) is unaffected by this because
  // per-route config overrides global.
  process.env["ATELIER_RATE_LIMIT_MAX"] = "5";
  process.env["ATELIER_RATE_LIMIT_WINDOW"] = "1 minute";

  app = buildServer(db);
  await app.ready();
});

afterAll(async () => {
  delete process.env["ATELIER_RATE_LIMIT_MAX"];
  delete process.env["ATELIER_RATE_LIMIT_WINDOW"];
  await app.close();
});

// @fastify/rate-limit's in-memory store persists across a single
// server instance. Give each test its own to avoid one test's
// bucket bleeding into the next.
beforeEach(() => {
  // no-op — rate-limit resets are handled by rebuilding the app
  // when a test needs a clean bucket. Since our tests use
  // distinct bearer tokens or IPs, buckets don't overlap.
});

describe("rate limiting", () => {
  it("returns 429 with retry-after headers once the per-token cap is hit", async () => {
    // Six requests in a row: 5 pass, the 6th trips the limit.
    let hit429 = false;
    for (let i = 0; i < 6; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/me",
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.statusCode === 429) {
        hit429 = true;
        expect(res.json().error).toBe("rate_limited");
        expect(res.headers["retry-after"]).toBeDefined();
        break;
      }
    }
    expect(hit429).toBe(true);
  });

  it("counts a different bearer token separately", async () => {
    // A brand-new token should have its own bucket, even though
    // the previous test drained the shared IP.
    const identity = identityRepo(db);
    const m2 = identity.createManager({ displayName: "M2", email: "m2@a.b" });
    const token2 = identity.mintToken({
      actorType: "manager",
      actorId: m2.id,
      label: "t2",
    }).token;
    // /me is a self-lookup route, no household context needed —
    // just make sure it doesn't 429 on the first request under a
    // fresh token.
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token2}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("skips the health check — infra probes don't count", async () => {
    // Blast /healthz many times over the cap; should never 429.
    for (let i = 0; i < 20; i++) {
      const res = await app.inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(200);
    }
  });

  it("per-route override applies to the mock webhook (looser than global)", async () => {
    // With the global cap set to 5 and the webhook override to 60,
    // we should be able to send >5 webhook requests from an
    // unauthenticated caller before hitting a limit. Send 10 —
    // all 10 should either 200 or 404 (unrouted), never 429.
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/messaging/inbound/mock",
        payload: {
          channel: "sms",
          from: "+14155551212",
          to: "+14155550000",
          body: `msg ${i}`,
          externalMessageId: `mock_rl_${i}`,
        },
      });
      expect(res.statusCode).not.toBe(429);
    }
  });
});
