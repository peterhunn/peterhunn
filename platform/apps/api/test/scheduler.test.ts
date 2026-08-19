import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import {
  openDb,
  credentialRepo,
  householdRepo,
  identityRepo,
} from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";
import { buildScheduler } from "../src/scheduler.js";

let db: ReturnType<typeof openDb>;
let hhWithGmail: HouseholdId;
let hhWithoutGmail: HouseholdId;
let hhRevokedGmail: HouseholdId;

const silentLogger = {
  info: () => {},
  error: () => {},
};

beforeAll(async () => {
  db = openDb({ url: ":memory:" });
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: "../../packages/db/migrations" });

  const identity = identityRepo(db);
  const m = identity.createManager({ displayName: "M", email: "m@a.b" });
  identity.mintToken({ actorType: "manager", actorId: m.id, label: "t" });
  const households = householdRepo(db);
  const credentials = credentialRepo(db);

  const a = households.create({ name: "With Gmail", tier: "life" });
  hhWithGmail = a.id;
  identity.grantHousehold({ managerId: m.id, householdId: a.id, role: "primary" });
  credentials.store({
    householdId: a.id,
    provider: "gmail",
    kind: "oauth2",
    label: "Gmail",
    credential: { access_token: "at", from_address: "a@example.com" },
  });

  const b = households.create({ name: "No Gmail", tier: "life" });
  hhWithoutGmail = b.id;
  identity.grantHousehold({ managerId: m.id, householdId: b.id, role: "primary" });

  const c = households.create({ name: "Revoked", tier: "life" });
  hhRevokedGmail = c.id;
  identity.grantHousehold({ managerId: m.id, householdId: c.id, role: "primary" });
  const revoked = credentials.store({
    householdId: c.id,
    provider: "gmail",
    kind: "oauth2",
    label: "Gmail (old)",
    credential: { access_token: "at-old", from_address: "c@example.com" },
  });
  credentials.revoke(revoked.id);
});

afterAll(() => {
  // In-memory sqlite; nothing to close.
});

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("background sync scheduler", () => {
  it("runOnce iterates only households with an unrevoked gmail credential", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        // Stamp which household id showed up (via the access_token used).
        if (url.includes("/users/me/messages")) {
          seen.push(url);
          return new Response(JSON.stringify({ messages: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );

    const scheduler = buildScheduler(db, {
      intervalSeconds: 60,
      logger: silentLogger,
    });
    const result = await scheduler.runOnce();

    expect(result.householdsChecked).toBe(3);
    expect(result.householdsSynced).toBe(1);
    expect(result.perHousehold).toHaveLength(1);
    expect(result.perHousehold[0]!.householdId).toBe(hhWithGmail);
    // Revoked and missing gmail households are skipped — no fetches for them.
    // We can't inspect ids from the URL but we know only the live household ran.
    expect(seen.length).toBeGreaterThan(0);
    void hhWithoutGmail;
    void hhRevokedGmail;
  });

  it("skips a second runOnce while the first is still in flight", async () => {
    let resolveFetch!: () => void;
    const gate = new Promise<void>((r) => (resolveFetch = r));

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/users/me/messages")) {
          await gate;
          return new Response(JSON.stringify({ messages: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );

    const scheduler = buildScheduler(db, {
      intervalSeconds: 60,
      logger: silentLogger,
    });
    const first = scheduler.runOnce();
    const second = await scheduler.runOnce();
    expect(second.householdsChecked).toBe(0);
    expect(second.householdsSynced).toBe(0);

    resolveFetch();
    const firstResult = await first;
    expect(firstResult.householdsChecked).toBe(3);
  });

  it("does not start when enabled is false", () => {
    const messages: string[] = [];
    const scheduler = buildScheduler(db, {
      intervalSeconds: 60,
      enabled: false,
      logger: {
        info: (msg) => messages.push(msg),
        error: () => {},
      },
    });
    scheduler.start();
    expect(messages.some((m) => m.includes("disabled"))).toBe(true);
    scheduler.stop();
  });
});
