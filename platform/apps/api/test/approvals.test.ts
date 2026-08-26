import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  openDb,
  householdRepo,
  identityRepo,
  policyRepo,
  graphRepo,
} from "@atelier/db";
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

  policyRepo(db).create({
    householdId: hh,
    spec: {
      effect: "allow",
      kind: "standing",
      subject: "any_principal",
      domain: "household",
      actionClass: "vendor.purchase",
      scope: {},
      autonomy: "execute",
      limits: { perActionUsd: 250 },
      approval: {
        conditions: [{ kind: "amount_gt", threshold: 250 }],
        fallbackApprover: "manager",
      },
      window: {},
      label: "Household purchase up to $250",
    },
    provenance: { source: "customer_direct", assertedBy: m.id, confidence: 1 },
  });

  graphRepo(db).createNode(hh, {
    type: "org.vendor",
    data: { name: "Marketplace", notes: "office supplies desk chair furnishings" },
    provenance: {
      source: "customer_direct",
      assertedBy: m.id,
      assertedAt: new Date().toISOString(),
      confidence: 1,
      status: "confirmed",
    },
  });

  app = buildServer(db);
  await app.ready();
});

afterAll(async () => await app.close());

describe("approval queue end-to-end", () => {
  it("enqueues an approval for a purchase over the limit and resolves it via approve", async () => {
    const runRes = await app.inject({
      method: "POST",
      url: `/households/${hh}/orchestrator/run`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        kind: "household.vendor.purchase",
        subjectPrincipalId: "any_principal",
        attrs: {
          itemDescription: "Ergonomic desk chair",
          serviceType: "office",
          amountUsd: 750,
        },
        origin: { source: "manager", by: "test" },
      },
    });
    expect(runRes.statusCode).toBe(200);
    const run = runRes.json().run;
    expect(run.tasks[0].state).toBe("escalated");

    const list = await app.inject({
      method: "GET",
      url: `/households/${hh}/approvals`,
      headers: { authorization: `Bearer ${token}` },
    });
    const approvals: Array<{ id: string; state: string; kind: string; summary: string }> =
      list.json().approvals;
    const pending = approvals.find((a) => a.state === "pending");
    expect(pending).toBeDefined();
    // Per-action limit violation short-circuits to manager_review
    // (the manager owns the "authorize an over-limit purchase"
    // decision); the amount_gt escalation on approval.conditions
    // would route to customer_approval, but it never runs because
    // the limits check happens first. See packages/policy/src/
    // engine.ts:evaluateLimits.
    expect(pending!.kind).toBe("manager_review");

    const approve = await app.inject({
      method: "POST",
      url: `/households/${hh}/approvals/${pending!.id}/approve`,
      headers: { authorization: `Bearer ${token}` },
      payload: { note: "confirmed with principal by SMS" },
    });
    expect(approve.statusCode).toBe(200);
    const approvedItem = approve.json().approval;
    expect(approvedItem.state).toBe("approved");
    expect(approvedItem.resultActionId).toBeDefined();

    const actions = await app.inject({
      method: "GET",
      url: `/households/${hh}/actions`,
      headers: { authorization: `Bearer ${token}` },
    });
    const list2: Array<{ id: string; outcome: string; actionClass: string; approverId: string | null }> =
      actions.json().actions;
    const recorded = list2.find((a) => a.id === approvedItem.resultActionId);
    expect(recorded?.outcome).toBe("succeeded");
    expect(recorded?.actionClass).toBe("vendor.purchase");
    expect(recorded?.approverId).toBeTruthy();
  });

  it("rejects a pending approval and closes the task", async () => {
    const runRes = await app.inject({
      method: "POST",
      url: `/households/${hh}/orchestrator/run`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        kind: "household.vendor.purchase",
        subjectPrincipalId: "any_principal",
        attrs: {
          itemDescription: "Second desk chair",
          serviceType: "office",
          amountUsd: 900,
        },
        origin: { source: "manager", by: "test" },
      },
    });
    const run = runRes.json().run;
    expect(run.tasks[0].state).toBe("escalated");

    const list = await app.inject({
      method: "GET",
      url: `/households/${hh}/approvals`,
      headers: { authorization: `Bearer ${token}` },
    });
    const approvals: Array<{ id: string; state: string }> = list.json().approvals;
    const pending = approvals.find((a) => a.state === "pending");
    expect(pending).toBeDefined();

    const reject = await app.inject({
      method: "POST",
      url: `/households/${hh}/approvals/${pending!.id}/reject`,
      headers: { authorization: `Bearer ${token}` },
      payload: { note: "Not urgent; declined." },
    });
    expect(reject.statusCode).toBe(200);
    expect(reject.json().approval.state).toBe("rejected");
  });

  it("returns an inbox listing across granted households", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/approvals/inbox",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const approvals: Array<{ state: string }> = res.json().approvals;
    for (const a of approvals) expect(a.state).toBe("pending");
  });
});
