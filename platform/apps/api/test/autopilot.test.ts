import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import {
  openDb,
  householdRepo,
  identityRepo,
  inboxRepo,
  approvalRepo,
  policyRepo,
  taskRepo,
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
  const policies = policyRepo(db);

  // Inbox agent proposes message.send. Without a matching allow
  // policy the engine would deny and no approval would enqueue —
  // seed the draft-authority policy from docs/33 so the flow
  // demotes into manager_review and lands in the approvals list.
  const seedMessageSendPolicy = (householdId: import("@atelier/domain").HouseholdId) =>
    policies.create({
      householdId,
      spec: {
        effect: "allow",
        kind: "standing",
        subject: "any_principal",
        domain: "communication",
        actionClass: "message.send",
        scope: {},
        autonomy: "draft",
        limits: {},
        approval: {
          conditions: [],
          fallbackApprover: "manager",
        },
        window: {},
        label: "Any outbound customer-voice message",
      },
      provenance: { source: "customer_direct", assertedBy: m.id, confidence: 1 },
    });

  const a = households.create({ name: "Autopilot on", tier: "life" });
  hh = a.id;
  identity.grantHousehold({ managerId: m.id, householdId: a.id, role: "primary" });
  seedMessageSendPolicy(hh);

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
    const approvals = approvalRepo(db).listPending(hh);
    expect(approvals.length).toBeGreaterThan(0);
    // Approval carries the proposing agent + the run's origin
    // denormalised onto the row itself so the console can render
    // the trigger without a join. Both surfaces still line up
    // with the orchestrator_runs row, cross-checked here.
    const first = approvals[0]!;
    expect(first.proposedBy.agent).toBe("inbox");
    expect(first.origin).toBe("proactive");
    expect(first.originBy).toBe("autopilot:inbox");
    const run = taskRepo(db).getRun(hh, first.runId);
    expect(run?.origin).toBe("proactive");
    expect(run?.originBy).toBe("autopilot:inbox");
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
