import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import {
  openDb,
  householdRepo,
  identityRepo,
  inboxRepo,
  approvalRepo,
} from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";
import { buildAutopilot } from "../src/autopilot.js";
import type { Db, InboxMessageRow } from "@atelier/db";

let db: Db;
let hh: HouseholdId;
let hhFrozen: HouseholdId;
let hhOptedOut: HouseholdId;

const silentLogger = { info: () => {}, error: () => {} };

beforeAll(async () => {
  db = openDb({ url: ":memory:" });
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: "../../packages/db/migrations" });

  const identity = identityRepo(db);
  const m = identity.createManager({ displayName: "M", email: "m@a.b" });
  identity.mintToken({ actorType: "manager", actorId: m.id, label: "t" });
  const households = householdRepo(db);

  const a = households.create({ name: "Autopilot on", tier: "life" });
  hh = a.id;
  identity.grantHousehold({ managerId: m.id, householdId: a.id, role: "primary" });

  const b = households.create({ name: "Frozen", tier: "life" });
  hhFrozen = b.id;
  identity.grantHousehold({ managerId: m.id, householdId: b.id, role: "primary" });
  households.freeze(hhFrozen, "manager on vacation");

  const c = households.create({ name: "Opted out", tier: "life" });
  hhOptedOut = c.id;
  identity.grantHousehold({ managerId: m.id, householdId: c.id, role: "primary" });
  households.setAutopilot(hhOptedOut, false);
});

beforeEach(() => {
  vi.unstubAllGlobals();
  // Prevent any tool that reaches for real HTTP from doing so.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 })),
  );
});
afterEach(() => vi.unstubAllGlobals());

const mkMessage = (subject: string): InboxMessageRow => {
  const row = inboxRepo(db).create({
    householdId: hh,
    fromName: "Sam",
    fromAddress: "sam@example.com",
    subject,
    body: "Please confirm by Friday.",
  });
  return row;
};

describe("autopilot", () => {
  it("dispatches inbox agent per fresh message and lands drafts in the approval queue", async () => {
    const row = mkMessage("Estimate confirmation");
    const autopilot = buildAutopilot(db, { logger: silentLogger });
    const summary = await autopilot.onNewInboxMessages(hh, [row]);
    expect(summary.dispatched).toBe(1);
    expect(summary.errors).toBe(0);

    // The inbox agent proposes message.send, which is draft-authority
    // → an approval row for this household exists.
    const approvals = approvalRepo(db).listOpen(hh);
    expect(approvals.length).toBeGreaterThan(0);
    // Approval carries the autopilot identity through — the exact
    // formatting is orchestrator-internal, but "autopilot" must
    // appear somewhere in proposedBy or the origin.
    const first = approvals[0]!;
    const trace = JSON.stringify(first);
    expect(trace.toLowerCase()).toContain("autopilot");
  });

  it("skips a frozen household without dispatching", async () => {
    const row = mkMessage("Should be skipped");
    // Move the row over to the frozen household for the test.
    // (Direct insert via the repo so we don't touch the real household routes.)
    const frozenRow = inboxRepo(db).create({
      householdId: hhFrozen,
      fromName: "Sam",
      fromAddress: "sam@example.com",
      subject: "Test",
      body: "Please confirm.",
    });
    const autopilot = buildAutopilot(db, { logger: silentLogger });
    const summary = await autopilot.onNewInboxMessages(hhFrozen, [frozenRow]);
    expect(summary.dispatched).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.reasons).toContain("household_frozen");
    void row;
  });

  it("skips a household that has opted out of autopilot", async () => {
    const row = inboxRepo(db).create({
      householdId: hhOptedOut,
      fromName: "Sam",
      fromAddress: "sam@example.com",
      subject: "Test",
      body: "Please confirm.",
    });
    const autopilot = buildAutopilot(db, { logger: silentLogger });
    const summary = await autopilot.onNewInboxMessages(hhOptedOut, [row]);
    expect(summary.dispatched).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.reasons).toContain("autopilot_disabled");
  });

  it("returns zero-work summary when handed an empty batch", async () => {
    const autopilot = buildAutopilot(db, { logger: silentLogger });
    const summary = await autopilot.onNewInboxMessages(hh, []);
    expect(summary).toEqual({ dispatched: 0, skipped: 0, errors: 0, reasons: [] });
  });
});
