import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import {
  openDb,
  householdPlaybookRepo,
  householdRepo,
  identityRepo,
} from "@atelier/db";
import { buildPlaybookRegistry, computeNextFireAt } from "@atelier/agents";
import type { HouseholdId } from "@atelier/domain";
import { buildServer } from "../src/server.js";
import { buildPlaybookRunner } from "../src/playbook-runner.js";
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

beforeEach(() => {
  vi.unstubAllGlobals();
  // Block real HTTP so any model calls in fired intents stay on the mock adapter.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 })),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("playbook registry + scheduling helper", () => {
  it("registers the three first-class playbooks with stable ids", () => {
    const ids = buildPlaybookRegistry()
      .list()
      .map((p) => p.id);
    expect(ids).toContain("admin.weekly-renewals-review");
    expect(ids).toContain("travel.prep-sweep");
    expect(ids).toContain("family.coverage-check");
  });

  it("weekly schedule ceils to next matching UTC day/hour", () => {
    // Tuesday 2026-01-06 at 09:00 UTC → next Monday 14:00 UTC (2026-01-12)
    const from = new Date("2026-01-06T09:00:00Z");
    const next = computeNextFireAt(
      { kind: "weekly", dayOfWeek: 1, hourUtc: 14 },
      from,
    );
    expect(next.toISOString()).toBe("2026-01-12T14:00:00.000Z");
  });

  it("monthly schedule ceils to next matching day-of-month", () => {
    const from = new Date("2026-01-15T09:00:00Z");
    const next = computeNextFireAt(
      { kind: "monthly", dayOfMonth: 1, hourUtc: 15 },
      from,
    );
    expect(next.toISOString()).toBe("2026-02-01T15:00:00.000Z");
  });
});

describe("playbook API", () => {
  it("lists all playbooks with per-household enable state", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/households/${hh}/playbooks`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json().playbooks;
    expect(list.length).toBeGreaterThanOrEqual(3);
    for (const p of list) {
      expect(p.enabled).toBe(false);
      expect(p.registered).toBe(false);
    }
  });

  it("PUT enables a playbook, GET reflects it, DELETE disables", async () => {
    const put = await app.inject({
      method: "PUT",
      url: `/households/${hh}/playbooks/admin.weekly-renewals-review`,
      headers: { authorization: `Bearer ${token}` },
      payload: { config: { windowDays: 90 } },
    });
    expect(put.statusCode).toBe(200);

    const row = householdPlaybookRepo(db).get(hh, "admin.weekly-renewals-review");
    expect(row).not.toBeNull();
    expect(row!.enabled).toBe("yes");
    expect((row!.config as { windowDays: number }).windowDays).toBe(90);

    const list = await app
      .inject({
        method: "GET",
        url: `/households/${hh}/playbooks`,
        headers: { authorization: `Bearer ${token}` },
      })
      .then((r) => r.json().playbooks);
    const seed = list.find(
      (p: { id: string }) => p.id === "admin.weekly-renewals-review",
    );
    expect(seed.enabled).toBe(true);
    expect(seed.config.windowDays).toBe(90);

    const del = await app.inject({
      method: "DELETE",
      url: `/households/${hh}/playbooks/admin.weekly-renewals-review`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(204);
    const after = householdPlaybookRepo(db).get(hh, "admin.weekly-renewals-review");
    expect(after!.enabled).toBe("no");
  });

  it("PUT on an unknown playbook 404s", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/households/${hh}/playbooks/does.not.exist`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("playbook runner", () => {
  it("fires an enabled + due playbook and advances next_fire_at", async () => {
    const repo = householdPlaybookRepo(db);
    // Enable a playbook with next_fire_at in the past so it's due.
    repo.upsert({
      householdId: hh,
      playbookId: "admin.weekly-renewals-review",
      config: { windowDays: 30 },
      nextFireAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const runner = buildPlaybookRunner(db);
    const fires = await runner.runDue();
    const fired = fires.find(
      (f) => f.playbookId === "admin.weekly-renewals-review",
    );
    expect(fired).toBeDefined();
    expect(fired!.outcome).toBe("fired");
    expect(fired!.runId).toBeTruthy();

    const after = repo.get(hh, "admin.weekly-renewals-review");
    expect(after!.lastFireAt).not.toBeNull();
    expect(after!.lastRunId).toBe(fired!.runId);
    // next_fire_at moved into the future.
    expect(Date.parse(after!.nextFireAt)).toBeGreaterThan(Date.now());
  });

  it("skips a frozen household but still advances next_fire_at (no backlog)", async () => {
    householdRepo(db).freeze(hh, "vacation");
    const repo = householdPlaybookRepo(db);
    repo.upsert({
      householdId: hh,
      playbookId: "family.coverage-check",
      config: { horizonDays: 30 },
      nextFireAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const runner = buildPlaybookRunner(db);
    const fires = await runner.runDue();
    const r = fires.find((f) => f.playbookId === "family.coverage-check");
    expect(r!.outcome).toBe("skipped");
    expect(r!.reason).toBe("household_frozen");

    const after = repo.get(hh, "family.coverage-check");
    expect(Date.parse(after!.nextFireAt)).toBeGreaterThan(Date.now());
    // clean up
    householdRepo(db).unfreeze(hh);
  });
});
