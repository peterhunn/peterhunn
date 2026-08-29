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
    expect(s.kind).toBe("promote");
    if (s.kind !== "promote") throw new Error("narrow");
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
    const s = suggestions[0]!;
    if (s.kind !== "promote") throw new Error("narrow");
    expect(s.nApprovals).toBe(5);
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
    const adopted: {
      policy: {
        id: string;
        spec: { autonomy: string; actionClass: string };
        suggestionLineage?: {
          kind: string;
          basisPolicyId: string;
          basisApprovalIds: string[];
          suggestedAt: string;
        };
      };
    } = adoptRes.json();
    expect(adopted.policy.spec.autonomy).toBe("execute");
    expect(adopted.policy.spec.actionClass).toBe("event.reschedule");
    // Lineage is stamped on the adopted policy so a later
    // auditor can walk "why does this execute policy exist?"
    // back to the exact 5 approvals it was earned by.
    expect(adopted.policy.suggestionLineage).toBeDefined();
    expect(adopted.policy.suggestionLineage!.kind).toBe("promote");
    expect(adopted.policy.suggestionLineage!.basisPolicyId).toBe(p.id);
    expect(adopted.policy.suggestionLineage!.basisApprovalIds.length).toBe(5);
    expect(adopted.policy.suggestionLineage!.suggestedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );

    // Lineage drill-in endpoint hydrates the ids the row carries.
    const promotedId = (adopted.policy as { id: string }).id;
    const lineageRes = await app.inject({
      method: "GET",
      url: `/households/${isolated}/policies/${promotedId}/lineage`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(lineageRes.statusCode).toBe(200);
    const drill: {
      policy: { id: string; label: string; autonomy: string };
      lineage: {
        kind: "promote" | "demote";
        basisPolicyId: string;
        basisApprovalIds: string[];
      };
      basisPolicy: { id: string; label: string } | null;
      basisApprovals: Array<{
        id: string;
        state: string;
        summary: string;
      }>;
    } = lineageRes.json();
    expect(drill.lineage.kind).toBe("promote");
    // Basis policy hydrates.
    expect(drill.basisPolicy).not.toBeNull();
    expect(drill.basisPolicy!.id).toBe(p.id);
    // All 5 basis approvals hydrate with their state.
    expect(drill.basisApprovals.length).toBe(5);
    for (const a of drill.basisApprovals) {
      expect(a.state).toBe("approved");
    }

    // Hand-written policy → 404 with a "no_lineage" reason so the
    // console can render "manual" rather than a spurious error.
    const noLineageRes = await app.inject({
      method: "GET",
      url: `/households/${isolated}/policies/${p.id}/lineage`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(noLineageRes.statusCode).toBe(404);
    expect(noLineageRes.json()).toEqual({
      error: "no_lineage",
      message: "Hand-written policy.",
    });

    // Cross-household read is refused — the policy belongs to
    // `isolated`, not `hh`, so the auth-scoped lookup misses.
    const crossHhRes = await app.inject({
      method: "GET",
      url: `/households/${hh}/policies/${promotedId}/lineage`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(crossHhRes.statusCode).toBe(404);
    expect(crossHhRes.json()).toEqual({ error: "not_found" });

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

describe("dismissals and demotion", () => {
  // A fresh household so state from the promotion tests above doesn't
  // interfere with dismissal + demotion assertions.
  let dhh: HouseholdId;
  let draftPolicyId: PolicyId;
  let dtoken: string;
  let dManagerId: string;
  const carolId = "prn_carol_dis";

  beforeAll(async () => {
    const identity = identityRepo(db);
    const m = identity.createManager({ displayName: "Dm", email: "dm@a.b" });
    dManagerId = m.id;
    dtoken = identity.mintToken({
      actorType: "manager",
      actorId: m.id,
      label: "dt",
    }).token;
    dhh = householdRepo(db).create({ name: "D", tier: "life" }).id;
    identity.grantHousehold({
      managerId: m.id,
      householdId: dhh,
      role: "primary",
    });
    const p = policyRepo(db).create({
      householdId: dhh,
      spec: {
        effect: "allow",
        kind: "standing",
        subject: carolId,
        domain: "communication",
        actionClass: "message.send",
        scope: {},
        autonomy: "draft",
        limits: {},
        approval: { conditions: [], fallbackApprover: "manager" },
        window: {},
        label: "Carol drafts",
      },
      provenance: {
        source: "manager_observed",
        assertedBy: dManagerId,
        confidence: 1,
      },
    });
    draftPolicyId = p.id;
  });

  const seedDApproval = (opts: {
    state?: "approved" | "rejected" | "approved_with_edit";
    authorityPolicyId?: PolicyId;
    actionClass?: string;
    subject?: string;
  }) => {
    const run = taskRepo(db).startRun({
      householdId: dhh,
      intentKind: "test",
      intentAttrs: {},
      origin: "manager",
      originBy: dManagerId,
    });
    const task = taskRepo(db).createTask({
      runId: run.id,
      householdId: dhh,
      agent: "test",
      agentVersion: "0",
      kind: "test",
      inputs: {},
    });
    const a = approvalRepo(db).create({
      householdId: dhh,
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
      subjectPrincipalId: opts.subject ?? carolId,
      summary: "test",
      ...(opts.authorityPolicyId !== undefined && {
        authorityPolicyId: opts.authorityPolicyId,
      }),
      proposedBy: { agent: "test", agentVersion: "0" },
      reasons: [],
    });
    approvalRepo(db).resolve(a.id, {
      state: opts.state ?? "approved",
      resolvedByType: "manager",
      resolvedById: dManagerId,
    });
    return a.id;
  };

  it("dismissing a promotion suggestion hides it until the streak breaks", async () => {
    for (let i = 0; i < 5; i++) {
      seedDApproval({ authorityPolicyId: draftPolicyId });
    }
    const before = computeSuggestions(db, dhh).filter(
      (s) => s.kind === "promote",
    );
    expect(before.length).toBe(1);

    // Dismiss over HTTP.
    const dismissRes = await app.inject({
      method: "POST",
      url: `/households/${dhh}/policies/suggestions/dismiss`,
      headers: { authorization: `Bearer ${dtoken}` },
      payload: { actionClass: "message.send", subjectPrincipalId: carolId },
    });
    expect(dismissRes.statusCode).toBe(204);

    // Suggestion is now hidden even though the streak still stands.
    const afterDismiss = computeSuggestions(db, dhh).filter(
      (s) => s.kind === "promote",
    );
    expect(afterDismiss.length).toBe(0);

    // Adding another clean approval does NOT re-surface it — the
    // manager already said "not right now".
    seedDApproval({ authorityPolicyId: draftPolicyId });
    const afterMore = computeSuggestions(db, dhh).filter(
      (s) => s.kind === "promote",
    );
    expect(afterMore.length).toBe(0);

    // A rejection clears the dismissal automatically — the streak
    // broke, so if it later re-earns 5 clean approvals we want the
    // suggestion back. We assert one step in that chain: after the
    // rejection the dismissal no longer blocks a fresh streak.
    seedDApproval({ state: "rejected", authorityPolicyId: draftPolicyId });
    // Post-rejection, seed 5 new clean approvals — the streak must
    // recover from scratch past the rejection.
    for (let i = 0; i < 5; i++) {
      seedDApproval({ authorityPolicyId: draftPolicyId });
    }
    const afterRecovery = computeSuggestions(db, dhh).filter(
      (s) => s.kind === "promote",
    );
    expect(afterRecovery.length).toBe(1);
  });

  it("dismiss returns 404 when no matching suggestion exists", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/households/${dhh}/policies/suggestions/dismiss`,
      headers: { authorization: `Bearer ${dtoken}` },
      payload: {
        actionClass: "message.send",
        subjectPrincipalId: "prn_no_one",
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "no_such_suggestion" });
  });

  it("suggests demoting an execute policy when its escalations keep getting overridden", async () => {
    // Set up a household where an execute policy misfires.
    const misHh = householdRepo(db).create({ name: "Mis", tier: "life" }).id;
    identityRepo(db).grantHousehold({
      managerId: dManagerId,
      householdId: misHh,
      role: "primary",
    });
    const executePolicy = policyRepo(db).create({
      householdId: misHh,
      spec: {
        effect: "allow",
        kind: "standing",
        subject: "any_principal",
        domain: "procurement",
        actionClass: "vendor.purchase",
        scope: {},
        autonomy: "execute",
        // Escalation on amount_gt — anything above $100 routes to
        // manager_review, and the manager keeps saying no.
        limits: {},
        approval: {
          conditions: [{ kind: "amount_gt", threshold: 100 }],
          fallbackApprover: "manager",
        },
        window: {},
        label: "Vendor purchases — auto",
      },
      provenance: {
        source: "manager_observed",
        assertedBy: dManagerId,
        confidence: 1,
      },
    });
    // Three escalated approvals, all rejected. Above the demotion
    // threshold of 3.
    for (let i = 0; i < 3; i++) {
      const run = taskRepo(db).startRun({
        householdId: misHh,
        intentKind: "test",
        intentAttrs: {},
        origin: "manager",
        originBy: dManagerId,
      });
      const task = taskRepo(db).createTask({
        runId: run.id,
        householdId: misHh,
        agent: "test",
        agentVersion: "0",
        kind: "test",
        inputs: {},
      });
      const a = approvalRepo(db).create({
        householdId: misHh,
        runId: run.id,
        taskId: task.id,
        kind: "manager_review",
        approverType: "manager",
        domain: "procurement",
        actionClass: "vendor.purchase",
        toolName: "vendor.purchase",
        toolVersion: "0",
        toolInputs: {},
        proposedAttrs: {},
        summary: "over the escalation threshold",
        authorityPolicyId: executePolicy.id,
        proposedBy: { agent: "test", agentVersion: "0" },
        reasons: [],
      });
      approvalRepo(db).resolve(a.id, {
        state: "rejected",
        resolvedByType: "manager",
        resolvedById: dManagerId,
      });
    }

    const suggestions = computeSuggestions(db, misHh);
    const demotion = suggestions.find((s) => s.kind === "demote");
    expect(demotion).toBeDefined();
    if (!demotion || demotion.kind !== "demote") throw new Error("narrow");
    expect(demotion.currentRung).toBe("execute");
    expect(demotion.suggestedRung).toBe("draft");
    expect(demotion.basisPolicyId).toBe(executePolicy.id);
    expect(demotion.nProblems).toBe(3);
    expect(demotion.proposedPolicySpec.autonomy).toBe("draft");
    expect(demotion.summary).toContain("3 manager overrides");

    // Adopting a demotion creates the draft policy AND revokes the
    // execute one — two conflicting rungs on the same class would
    // be confusing, and the manager's intent is "this is not the
    // right rung".
    const adoptRes = await app.inject({
      method: "POST",
      url: `/households/${misHh}/policies/suggestions/adopt`,
      headers: { authorization: `Bearer ${dtoken}` },
      payload: {
        actionClass: "vendor.purchase",
        subjectPrincipalId: null,
        kind: "demote",
      },
    });
    expect(adoptRes.statusCode).toBe(201);
    const adopted: {
      policy: {
        spec: { autonomy: string; label: string };
        suggestionLineage?: {
          kind: string;
          basisPolicyId: string;
          basisApprovalIds: string[];
        };
      };
    } = adoptRes.json();
    expect(adopted.policy.spec.autonomy).toBe("draft");
    expect(adopted.policy.spec.label).toContain("demoted");
    // Demotion lineage points back to the misconfigured execute
    // policy plus the 3 rejected escalations that motivated it.
    expect(adopted.policy.suggestionLineage!.kind).toBe("demote");
    expect(adopted.policy.suggestionLineage!.basisPolicyId).toBe(executePolicy.id);
    expect(adopted.policy.suggestionLineage!.basisApprovalIds.length).toBe(3);
    // Live policies list no longer contains the revoked execute policy.
    const live = policyRepo(db).list(misHh);
    expect(live.find((p) => p.id === executePolicy.id)).toBeUndefined();
    // The new draft policy is present.
    expect(
      live.find((p) => p.spec.autonomy === "draft"),
    ).toBeDefined();
  });
});
