import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  openDb,
  approvalRepo,
  auditRepo,
  auditEvents,
  householdRepo,
  identityRepo,
  taskRepo,
  type Db,
} from "@atelier/db";
import { eq, and } from "drizzle-orm";
import type { HouseholdId, PolicyId } from "@atelier/domain";
import { buildServer } from "../src/server.js";
import { runExpirationPass } from "../src/approval-expiry.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let db: Db;
let token: string;
let managerId: string;
let hh: HouseholdId;

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

const seedApproval = (opts: {
  deadlineAt?: string;
  authorityPolicyId?: PolicyId;
}) => {
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
  const a = approvalRepo(db).create({
    householdId: hh,
    runId: run.id,
    taskId: task.id,
    kind: "manager_review",
    approverType: "manager",
    domain: "communication",
    actionClass: "message.send",
    toolName: "messaging.send",
    toolVersion: "0",
    toolInputs: {},
    proposedAttrs: {},
    subjectPrincipalId: "prn_test",
    summary: "test send needs approval",
    ...(opts.authorityPolicyId !== undefined && {
      authorityPolicyId: opts.authorityPolicyId,
    }),
    proposedBy: { agent: "test", agentVersion: "0" },
    reasons: [],
    ...(opts.deadlineAt !== undefined && { deadlineAt: opts.deadlineAt }),
  });
  return { approvalId: a.id, taskId: task.id, runId: run.id };
};

beforeAll(async () => {
  db = openDb({ url: ":memory:" });
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: "../../packages/db/migrations" });

  const identity = identityRepo(db);
  const m = identity.createManager({
    displayName: "Exp Manager",
    email: "exp@a.b",
  });
  managerId = m.id;
  token = identity.mintToken({
    actorType: "manager",
    actorId: m.id,
    label: "t",
  }).token;
  hh = householdRepo(db).create({ name: "H", tier: "life" }).id;
  identity.grantHousehold({ managerId: m.id, householdId: hh, role: "primary" });

  app = buildServer(db);
  await app.ready();
});

afterAll(async () => await app.close());

describe("approval expiry sweeper", () => {
  it("no-op when nothing has slipped — pass returns { expired: 0 }", () => {
    const result = runExpirationPass(db);
    expect(result.expired).toBe(0);
  });

  it("leaves in-window approvals alone (deadline is in the future)", () => {
    const { approvalId } = seedApproval({ deadlineAt: iso(3_600_000) }); // 1h from now
    const result = runExpirationPass(db);
    expect(result.expired).toBe(0);
    const still = approvalRepo(db).get(approvalId);
    expect(still?.state).toBe("pending");
  });

  it("leaves deadline-less approvals alone (no deadlineAt means no auto-expiry)", () => {
    const { approvalId } = seedApproval({});
    const result = runExpirationPass(db);
    expect(result.expired).toBe(0);
    const still = approvalRepo(db).get(approvalId);
    expect(still?.state).toBe("pending");
  });

  it("expires a past-deadline approval, shelves its task, and writes an audit event", () => {
    const { approvalId, taskId } = seedApproval({ deadlineAt: iso(-60_000) }); // 1min past
    const result = runExpirationPass(db);
    expect(result.expired).toBe(1);
    expect(result.byHousehold[hh]).toBe(1);

    const approval = approvalRepo(db).get(approvalId);
    expect(approval?.state).toBe("expired");
    expect(approval?.resolvedByType).toBe("manager");
    expect(approval?.resolvedById).toBe("system:approval-expiry");
    expect(approval?.resolutionNote).toContain("Auto-expired");

    const task = taskRepo(db).getTask(hh, taskId);
    expect(task?.state).toBe("shelved");
    expect(task?.decisionSummary).toContain("expired without resolution");

    // Audit event landed under action="approval.expired" and
    // references the approval id.
    const evt = db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "approval.expired"),
          eq(auditEvents.resourceId, approvalId),
        ),
      )
      .get();
    expect(evt).toBeDefined();
    expect(evt!.actorId).toBe("system:approval-expiry");
    // The auditRepo import is used for its side-effect of appending
    // to the Merkle DAG; not consumed further in the test.
    void auditRepo;
  });

  it("is idempotent — a second sweep expires nothing new", () => {
    const before = runExpirationPass(db);
    expect(before.expired).toBe(0);
  });

  it("stale_approval attention item surfaces before the sweeper acts", async () => {
    // Fresh approval whose deadline lands in 2 hours — inside the
    // 24h attention window but not yet expirable.
    const { approvalId } = seedApproval({ deadlineAt: iso(2 * 3_600_000) });
    const res = await app.inject({
      method: "GET",
      url: "/me/attention",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body: {
      counts: { staleApprovals: number };
      items: Array<{
        kind: string;
        detail: Record<string, unknown>;
        summary: string;
      }>;
    } = res.json();
    expect(body.counts.staleApprovals).toBeGreaterThanOrEqual(1);
    const stale = body.items.find(
      (it) => it.kind === "stale_approval" && it.detail.approvalId === approvalId,
    );
    expect(stale).toBeDefined();
    expect(stale!.summary).toContain("due in");
    expect(stale!.summary).toContain("test send needs approval");

    // Sweeping this early one does nothing — the deadline is in
    // the future.
    const sweep = runExpirationPass(db);
    expect(sweep.expired).toBe(0);
  });

  it("stale_approval item marks an overdue-but-not-yet-swept approval", async () => {
    const { approvalId } = seedApproval({ deadlineAt: iso(-3600_000) });
    const res = await app.inject({
      method: "GET",
      url: "/me/attention",
      headers: { authorization: `Bearer ${token}` },
    });
    const body: {
      items: Array<{
        kind: string;
        detail: Record<string, unknown>;
        summary: string;
      }>;
    } = res.json();
    const overdue = body.items.find(
      (it) =>
        it.kind === "stale_approval" && it.detail.approvalId === approvalId,
    );
    expect(overdue).toBeDefined();
    expect(overdue!.detail.overdue).toBe(true);
    expect(overdue!.summary).toContain("overdue");

    // Sweep it and re-check: gone from attention.
    const sweep = runExpirationPass(db);
    expect(sweep.expired).toBeGreaterThanOrEqual(1);
    const afterRes = await app.inject({
      method: "GET",
      url: "/me/attention",
      headers: { authorization: `Bearer ${token}` },
    });
    const after: {
      items: Array<{ kind: string; detail: Record<string, unknown> }>;
    } = afterRes.json();
    expect(
      after.items.find(
        (it) =>
          it.kind === "stale_approval" &&
          it.detail.approvalId === approvalId,
      ),
    ).toBeUndefined();
  });
});
