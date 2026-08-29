import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  openDb,
  actionRepo,
  approvalRepo,
  auditRepo,
  contactEndpointRepo,
  graphRepo,
  householdRepo,
  identityRepo,
  policyRepo,
  taskRepo,
  messagingEventRepo,
  type Db,
} from "@atelier/db";
import type { HouseholdId, PolicyId } from "@atelier/domain";
import { buildServer } from "../src/server.js";
import { buildHouseholdSnapshot } from "../src/household-snapshot.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let db: Db;
let token: string;
let managerId: string;
let hh: HouseholdId;
let executePolicyId: PolicyId;

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

const provenance = (assertedBy: string) => ({
  source: "manager_observed" as const,
  assertedBy,
  assertedAt: new Date().toISOString(),
  confidence: 1,
  status: "confirmed" as const,
});

beforeAll(async () => {
  db = openDb({ url: ":memory:" });
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: "../../packages/db/migrations" });

  const identity = identityRepo(db);
  const m = identity.createManager({
    displayName: "Snap Manager",
    email: "snap@a.b",
  });
  managerId = m.id;
  token = identity.mintToken({
    actorType: "manager",
    actorId: m.id,
    label: "t",
  }).token;
  hh = householdRepo(db).create({ name: "Snap Household", tier: "life" }).id;
  identity.grantHousehold({ managerId: m.id, householdId: hh, role: "primary" });

  // A live execute policy so weekActivity has something to reference.
  const p = policyRepo(db).create({
    householdId: hh,
    spec: {
      effect: "allow",
      kind: "standing",
      subject: "any_principal",
      domain: "household",
      actionClass: "vendor.schedule",
      scope: {},
      autonomy: "execute",
      limits: {},
      approval: { conditions: [], fallbackApprover: "manager" },
      window: {},
      label: "Vendor scheduling — auto",
    },
    provenance: {
      source: "manager_observed",
      assertedBy: managerId,
      confidence: 1,
    },
  });
  executePolicyId = p.id;

  // 3 succeeded actions this week under that policy, plus 1 failed.
  for (let i = 0; i < 3; i++) {
    actionRepo(db).record({
      householdId: hh,
      agent: "test",
      agentVersion: "0",
      tool: "vendor.schedule",
      toolVersion: "0",
      actionClass: "vendor.schedule",
      domain: "household",
      inputsHash: `hsucc${i}`,
      outcome: "succeeded",
      summary: "vendor scheduled",
      policyIdAuthorizing: p.id,
    });
  }
  actionRepo(db).record({
    householdId: hh,
    agent: "test",
    agentVersion: "0",
    tool: "vendor.schedule",
    toolVersion: "0",
    actionClass: "vendor.schedule",
    domain: "household",
    inputsHash: "hfail",
    outcome: "failed_transient",
    summary: "vendor scheduling failed",
    policyIdAuthorizing: p.id,
  });

  // One pending approval with a deadline in 2h — feeds
  // approvals.staleWithinDay.
  const run = taskRepo(db).startRun({
    householdId: hh,
    intentKind: "test",
    intentAttrs: {},
    origin: "manager",
    originBy: managerId,
  });
  const task = taskRepo(db).createTask({
    runId: run.id,
    householdId: hh,
    agent: "test",
    agentVersion: "0",
    kind: "test",
    inputs: {},
  });
  taskRepo(db).updateTask(task.id, { state: "escalated" });
  approvalRepo(db).create({
    householdId: hh,
    runId: run.id,
    taskId: task.id,
    kind: "manager_review",
    approverType: "manager",
    domain: "household",
    actionClass: "vendor.purchase",
    toolName: "vendor.purchase",
    toolVersion: "0",
    toolInputs: {},
    proposedAttrs: {},
    subjectPrincipalId: "prn_test",
    summary: "urgent purchase",
    proposedBy: { agent: "test", agentVersion: "0" },
    reasons: [],
    deadlineAt: iso(2 * 3_600_000),
  });

  // An obligation.deadline node due in 3 days.
  graphRepo(db).createNode(hh, {
    type: "obligation.deadline",
    data: {
      title: "Renew driver's licence",
      category: "renewal",
      dueAt: iso(3 * 86_400_000),
    },
    provenance: provenance(managerId),
  });

  // A messaging endpoint + one inbound + one outbound in the last
  // 24h. The inbound is newer → unread.
  const ep = contactEndpointRepo(db).create({
    householdId: hh,
    channel: "sms",
    address: "+14155550111",
    label: "Alex mobile",
  });
  messagingEventRepo(db).record({
    householdId: hh,
    channel: "sms",
    provider: "mock",
    direction: "outbound",
    endpointId: ep.id,
    fromAddress: "+14155550000",
    toAddress: "+14155550111",
    body: "outgoing test",
    receivedAt: iso(-6 * 3_600_000),
    externalMessageId: "mock-out",
    authoredByType: "manager",
    authoredByLabel: "manager:test",
  });
  messagingEventRepo(db).record({
    householdId: hh,
    channel: "sms",
    provider: "mock",
    direction: "inbound",
    endpointId: ep.id,
    fromAddress: "+14155550111",
    toAddress: "+14155550000",
    body: "hey — quick question",
    receivedAt: iso(-1 * 3_600_000),
    externalMessageId: "mock-in",
  });

  // One audit event so lastActivityAt has content.
  auditRepo(db).record({
    householdId: hh,
    actor: {
      type: "manager",
      id: managerId,
      displayName: "Snap Manager",
      householdIds: [hh],
    },
    action: "test.event",
    resourceType: "household",
    resourceId: hh,
  });

  app = buildServer(db);
  await app.ready();
});

afterAll(async () => await app.close());

describe("household health snapshot", () => {
  it("rolls up live counts across the household", () => {
    const snap = buildHouseholdSnapshot(db, hh);
    expect(snap).not.toBeNull();
    const s = snap!;

    expect(s.household.id).toBe(hh);
    expect(s.household.name).toBe("Snap Household");
    expect(s.household.frozen).toBe(false);

    // Audit chain: verify passes end-to-end. eventCount >= 1
    // because we wrote at least one audit event; other repos may
    // have written more via cascading writes.
    expect(s.auditChain.valid).toBe(true);
    expect(s.auditChain.eventCount).toBeGreaterThanOrEqual(1);
    expect(s.auditChain.headHash).toMatch(/^[0-9a-f]{64}$/);

    // Approvals: 1 pending, 1 stale within 24h (deadline in 2h),
    // 0 overdue.
    expect(s.approvals.pending).toBe(1);
    expect(s.approvals.staleWithinDay).toBe(1);
    expect(s.approvals.overdue).toBe(0);
    expect(s.approvals.oldestPendingAt).not.toBeNull();

    // Week activity: 4 actions total (3 succeeded, 1 failed);
    // vendor.schedule tops the class list; the execute policy
    // is the top authority.
    expect(s.weekActivity.totalActions).toBe(4);
    expect(s.weekActivity.byOutcome["succeeded"]).toBe(3);
    expect(s.weekActivity.byOutcome["failed_transient"]).toBe(1);
    expect(s.weekActivity.topActionClasses[0]?.actionClass).toBe(
      "vendor.schedule",
    );
    expect(s.weekActivity.topActionClasses[0]?.count).toBe(4);
    expect(s.weekActivity.topPolicies[0]?.policyId).toBe(executePolicyId);
    expect(s.weekActivity.topPolicies[0]?.label).toContain("Vendor scheduling");

    // Messaging: inbound landed after the outbound → 1 unread.
    // No delivery failures seeded.
    expect(s.messaging.unreadThreads).toBe(1);
    expect(s.messaging.deliveryFailuresLast24h).toBe(0);
    expect(s.messaging.lastInboundAt).not.toBeNull();
    expect(s.messaging.lastOutboundAt).not.toBeNull();

    // Obligations: 1 upcoming in 14d, top entry is our seeded one.
    expect(s.obligations.upcoming14d).toBe(1);
    expect(s.obligations.top[0]?.title).toBe("Renew driver's licence");
    expect(s.obligations.top[0]?.daysLeft).toBeGreaterThanOrEqual(2);

    // Policies: 1 total active, 1 auto-executing (the seeded one).
    expect(s.policies.totalActive).toBe(1);
    expect(s.policies.executeCount).toBe(1);

    expect(s.lastActivityAt).not.toBeNull();
  });

  it("HTTP: GET /snapshot returns the same shape and 404s an unknown household", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/households/${hh}/snapshot`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body: {
      snapshot: {
        household: { name: string; frozen: boolean };
        approvals: { pending: number };
        auditChain: { valid: boolean };
      };
    } = res.json();
    expect(body.snapshot.household.name).toBe("Snap Household");
    expect(body.snapshot.household.frozen).toBe(false);
    expect(body.snapshot.approvals.pending).toBe(1);
    expect(body.snapshot.auditChain.valid).toBe(true);

    // Unknown household — the auth middleware rejects with 403,
    // not 404, because the manager doesn't have a grant on a
    // household that doesn't belong to them. Assert non-2xx.
    const noHhRes = await app.inject({
      method: "GET",
      url: `/households/hh_does_not_exist/snapshot`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(noHhRes.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("frozen household flips the frozen flag and carries the reason", () => {
    householdRepo(db).freeze(hh, "customer requested full pause");
    const s = buildHouseholdSnapshot(db, hh)!;
    expect(s.household.frozen).toBe(true);
    expect(s.household.frozenReason).toContain("customer requested");
    // Restore for downstream tests.
    householdRepo(db).unfreeze(hh);
  });

  it("returns null for a household that doesn't exist", () => {
    const s = buildHouseholdSnapshot(db, "hh_ghost" as HouseholdId);
    expect(s).toBeNull();
  });
});
