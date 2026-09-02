import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
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

// Gmail sync flows through @googleapis/gmail (gaxios), not global
// fetch — intercept at the socket layer with MSW so the SDK's
// requests actually resolve without the internet.
const server = setupServer();

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

  server.listen({ onUnhandledRequest: "bypass" });
});

afterAll(() => {
  server.close();
});

beforeEach(() => server.resetHandlers());
afterEach(() => server.resetHandlers());

describe("background sync scheduler", () => {
  it("runOnce iterates only households with an unrevoked gmail credential", async () => {
    let listHits = 0;
    server.use(
      http.get(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        () => {
          listHits++;
          return HttpResponse.json({ messages: [], resultSizeEstimate: 0 });
        },
      ),
      http.get(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events",
        () => HttpResponse.json({ items: [] }),
      ),
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
    // Revoked and missing gmail households are skipped — only the
    // live household drove the Gmail SDK.
    expect(listHits).toBe(1);
    void hhWithoutGmail;
    void hhRevokedGmail;
  });

  it("skips a second runOnce while the first is still in flight", async () => {
    let resolveFetch!: () => void;
    const gate = new Promise<void>((r) => (resolveFetch = r));

    server.use(
      http.get(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        async () => {
          await gate;
          return HttpResponse.json({ messages: [], resultSizeEstimate: 0 });
        },
      ),
      http.get(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events",
        () => HttpResponse.json({ items: [] }),
      ),
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
