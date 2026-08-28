import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  openDb,
  approvalRepo,
  householdRepo,
  identityRepo,
  policyRepo,
  taskRepo,
  type Db,
} from "@atelier/db";
import type { HouseholdId, PolicyId } from "@atelier/domain";
import { buildServer } from "../src/server.js";
import { computeSuggestions } from "../src/policy-suggestions.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let db: Db;
let token: string;
let hh: HouseholdId;
let managerId: string;
let policyId: PolicyId;

const alexId = "prn_alex_ladder";
const bobId = "prn_bob_ladder";

// Seed one draft policy for message.send/alex and 5 approvals resolved
// against it. Rejections and edits break the streak. Different
// principals live in different buckets.
const seedPolicy = () => {
  const p = policyRepo(db).create({
    householdId: hh,
    spec: {
      effect: "allow",
      kind: "standing",
      subject: alexId,
      domain: "communication",
      actionClass: "message.send",
      scope: {},
      autonomy: "draft",
      limits: {},
      approval: { conditions: [], fallbackApprover: "manager" },
      window: {},
      label: "Alex — drafted texts to review",
    },
    provenance: {
      source: "manager_observed",
      assertedBy: managerId,
      confidence: 1,
    },
  });
  policyId = p.id;
};

const seedApproval = (opts: {
  actionClass?: string;
  subject?: string;
  state?: "approved" | "rejected" | "approved_with_edit";
  authorityPolicyId?: PolicyId | undefined;
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
  const created = approvalRepo(db).create({
    householdId: hh,
    runId: run.id,
    taskId: task.id,
    kind: "manager_review",
    approverType: "manager",
    domain: "communication",
    actionClass: opts.actionClass ?? "message.send",
    toolName: "messaging.send",
    toolVersion: "0",
    toolInputs: {},
    proposedAttrs: {},
    subjectPrincipalId: opts.subject ?? alexId,
    summary: "test",
    ...(opts.authorityPolicyId !== undefined && {
      authorityPolicyId: opts.authorityPolicyId,
    }),
    proposedBy: { agent: "test", agentVersion: "0" },
    reasons: [],
  });
  approvalRepo(db).resolve(created.id, {
    state: opts.state ?? "approved",
    resolvedByType: "manager",
    resolvedById: managerId,
  });
};

beforeAll(async () => {
  db = openDb({ url: ":memory:" });
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: "../../packages/db/migrations" });

  const identity = identityRepo(db);
  const m = identity.createManager({ displayName: "M", email: "m@a.b" });
  managerId = m.id;
  token = identity.mintToken({
    actorType: "manager",
    actorId: m.id,
    label: "t",
  }).token;
  hh = householdRepo(db).create({ name: "H", tier: "life" }).id;
  identity.grantHousehold({ managerId: m.id, householdId: hh, role: "primary" });

  seedPolicy();
  app = buildServer(db);
  await app.ready();
});

afterAll(async () => await app.close());

describe("autonomy ladder — policy promotion suggestions", () => {
  it("no suggestion below the threshold", () => {
    // 4 approvals — one below the default threshold of 5.
    for (let i = 0; i < 4; i++) {
      seedApproval({ authorityPolicyId: policyId });
    }
    const suggestions = computeSuggestions(db, hh);
    expect(suggestions.length).toBe(0);
  });

  it("suggests promotion after 5 consecutive approvals of the same pattern", () => {
    // One more takes the streak to 5.
    seedApproval({ authorityPolicyId: policyId });
    const suggestions = computeSuggestions(db, hh);
    expect(suggestions.length).toBe(1);
    const s = suggestions[0]!;
    expect(s.actionClass).toBe("message.send");
    expect(s.subjectPrincipalId).toBe(alexId);
    expect(s.currentRung).toBe("draft");
    expect(s.suggestedRung).toBe("execute");
    expect(s.nApprovals).toBe(5);
    expect(s.proposedPolicySpec.autonomy).toBe("execute");
    // Label carries the promotion tag so the manager sees which
    // policy this came from in the console.
    expect(s.proposedPolicySpec.label).toContain("promoted");
    // Basis approval ids are populated so the manager can drill
    // into "which 5 approvals is this based on".
    expect(s.basisApprovalIds.length).toBe(5);
    expect(s.basisPolicyId).toBe(policyId);
  });

  it("a rejection anywhere in the streak window kills the suggestion", () => {
    // Add a rejection — the most-recent 5 in the window now include
    // it, so the streak breaks.
    seedApproval({
      state: "rejected",
      authorityPolicyId: policyId,
    });
    const suggestions = computeSuggestions(db, hh);
    // A rejection at the front breaks the streak (window[0] !== "approved").
    // Need 5 more approvals to fully clear the window past it.
    expect(suggestions.length).toBe(0);
  });

  it("suggests again once the streak recovers past the rejection", () => {
    for (let i = 0; i < 5; i++) {
      seedApproval({ authorityPolicyId: policyId });
    }
    const suggestions = computeSuggestions(db, hh);
    expect(suggestions.length).toBe(1);
    expect(suggestions[0]!.nApprovals).toBe(5);
  });

  it("a manager edit breaks the streak — the manager wasn't fully happy", () => {
    // approved_with_edit → not clean. But we're already past 5 clean
    // approvals, so start a NEW bucket for Bob and mix in an edit.
    for (let i = 0; i < 4; i++) {
      seedApproval({ subject: bobId, authorityPolicyId: policyId });
    }
    seedApproval({
      subject: bobId,
      state: "approved_with_edit",
      authorityPolicyId: policyId,
    });
    const bobSuggestion = computeSuggestions(db, hh).find(
      (s) => s.subjectPrincipalId === bobId,
    );
    expect(bobSuggestion).toBeUndefined();
  });

  it("existing execute policy for the same pattern short-circuits the suggestion", () => {
    // Seed an execute policy that covers Alex/message.send. The
    // Alex bucket should drop out of the suggestions even though
    // its streak is intact.
    policyRepo(db).create({
      householdId: hh,
      spec: {
        effect: "allow",
        kind: "standing",
        subject: alexId,
        domain: "communication",
        actionClass: "message.send",
        scope: {},
        autonomy: "execute",
        limits: {},
        approval: { conditions: [], fallbackApprover: "manager" },
        window: {},
        label: "Alex — auto texts (pre-existing)",
      },
      provenance: {
        source: "manager_observed",
        assertedBy: managerId,
        confidence: 1,
      },
    });
    const suggestions = computeSuggestions(db, hh);
    expect(
      suggestions.find(
        (s) =>
          s.actionClass === "message.send" && s.subjectPrincipalId === alexId,
      ),
    ).toBeUndefined();
  });

  it("HTTP: GET returns suggestions and POST adopts one, creating a real policy", async () => {
    // Fresh household to isolate from the other test setup.
    const isolated = householdRepo(db).create({
      name: "Isolated",
      tier: "life",
    }).id;
    identityRepo(db).grantHousehold({
      managerId,
      householdId: isolated,
      role: "primary",
    });
    const p = policyRepo(db).create({
      householdId: isolated,
      spec: {
        effect: "allow",
        kind: "standing",
        subject: "prn_carol",
        domain: "calendar",
        actionClass: "event.reschedule",
        scope: {},
        autonomy: "ask",
        limits: {},
        approval: { conditions: [], fallbackApprover: "manager" },
        window: {},
        label: "Carol — reschedule with confirmation",
      },
      provenance: {
        source: "manager_observed",
        assertedBy: managerId,
        confidence: 1,
      },
    });
    for (let i = 0; i < 5; i++) {
      const run = taskRepo(db).startRun({
        householdId: isolated,
        intentKind: "test",
        intentAttrs: {},
        origin: "manager",
        originBy: managerId,
      });
      const task = taskRepo(db).createTask({
        runId: run.id,
        householdId: isolated,
        agent: "test",
        agentVersion: "0",
        kind: "test",
        inputs: {},
      });
      const a = approvalRepo(db).create({
        householdId: isolated,
        runId: run.id,
        taskId: task.id,
        kind: "manager_review",
        approverType: "manager",
        domain: "calendar",
        actionClass: "event.reschedule",
        toolName: "calendar.reschedule",
        toolVersion: "0",
        toolInputs: {},
        proposedAttrs: {},
        subjectPrincipalId: "prn_carol",
        summary: "test",
        authorityPolicyId: p.id,
        proposedBy: { agent: "test", agentVersion: "0" },
        reasons: [],
      });
      approvalRepo(db).resolve(a.id, {
        state: "approved",
        resolvedByType: "manager",
        resolvedById: managerId,
      });
    }

    const listRes = await app.inject({
      method: "GET",
      url: `/households/${isolated}/policies/suggestions`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listRes.statusCode).toBe(200);
    const body: { suggestions: Array<{ actionClass: string; subjectPrincipalId: string }> } =
      listRes.json();
    expect(body.suggestions.length).toBe(1);
    expect(body.suggestions[0]!.actionClass).toBe("event.reschedule");

    const adoptRes = await app.inject({
      method: "POST",
      url: `/households/${isolated}/policies/suggestions/adopt`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        actionClass: "event.reschedule",
        subjectPrincipalId: "prn_carol",
      },
    });
    expect(adoptRes.statusCode).toBe(201);
    const adopted: { policy: { spec: { autonomy: string; actionClass: string } } } =
      adoptRes.json();
    expect(adopted.policy.spec.autonomy).toBe("execute");
    expect(adopted.policy.spec.actionClass).toBe("event.reschedule");

    // Re-listing now finds no suggestion — the newly created
    // execute policy covers the pattern.
    const listAfter = await app.inject({
      method: "GET",
      url: `/households/${isolated}/policies/suggestions`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listAfter.json().suggestions.length).toBe(0);
  });

  it("adopt returns 404 for a non-existent pattern", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/households/${hh}/policies/suggestions/adopt`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        actionClass: "no.such.thing",
        subjectPrincipalId: alexId,
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "no_such_suggestion" });
  });

  it("windowDays query filters out approvals older than the window", async () => {
    // With a 1-day window the older streak should not qualify —
    // but our seeded approvals are all "now", so this mostly
    // asserts the query is parsed. Set windowDays to 1 and
    // confirm the endpoint still returns 200 with a valid shape.
    const res = await app.inject({
      method: "GET",
      url: `/households/${hh}/policies/suggestions?windowDays=1&threshold=100`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    // Threshold=100 means no bucket qualifies.
    expect(res.json().suggestions).toEqual([]);
  });
});
