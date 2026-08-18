import { describe, it, expect } from "vitest";
import {
  newPolicyId,
  type ActionRequest,
  type HouseholdId,
  type Policy,
  type PolicyId,
} from "@atelier/domain";
import { evaluate, type EvaluatorDeps } from "../src/engine.js";

const HH = "hh_test" as HouseholdId;

const mkPolicy = (overrides: Partial<Policy["spec"]> & Pick<Policy["spec"], "domain" | "actionClass" | "autonomy">, id?: PolicyId): Policy => ({
  id: id ?? newPolicyId(),
  householdId: HH,
  spec: {
    effect: "allow",
    kind: "standing",
    subject: "any_principal",
    scope: {},
    limits: {},
    approval: { conditions: [], fallbackApprover: "manager" },
    window: {},
    label: "test",
    ...overrides,
  } as Policy["spec"],
  provenance: {
    source: "customer_direct",
    assertedBy: "mgr_test",
    assertedAt: "2026-01-01T00:00:00.000Z",
    confidence: 1,
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  revokedAt: undefined,
  consumedByActionId: undefined,
});

const mkDeps = (opts: {
  policies?: Policy[];
  rollupAmount?: number;
  rollupCount?: number;
  frozen?: boolean;
}): EvaluatorDeps => ({
  policies: {
    match: () => opts.policies ?? [],
  },
  rollups: {
    amountRollup: () => opts.rollupAmount ?? 0,
    countRollup: () => opts.rollupCount ?? 0,
  },
  household: {
    isFrozen: () => opts.frozen ?? false,
  },
});

const mkRequest = (overrides: Partial<ActionRequest> = {}): ActionRequest => ({
  subjectPrincipalId: "any_principal",
  domain: "household",
  actionClass: "vendor.schedule",
  sideEffectClass: "write_reversible",
  attrs: {},
  proposedBy: { actor: "test", version: "0" },
  now: "2026-06-15T12:00:00.000Z",
  ...overrides,
});

describe("policy engine", () => {
  it("shelves everything when the household is frozen", () => {
    const d = evaluate(mkDeps({ frozen: true }), {
      householdId: HH,
      request: mkRequest(),
    });
    expect(d.decision).toBe("shelved");
    expect(d.reasons).toContain("household_frozen");
  });

  it("denies when no matching policy exists", () => {
    const d = evaluate(mkDeps({}), { householdId: HH, request: mkRequest() });
    expect(d.decision).toBe("denied");
    expect(d.reasons).toContain("no_matching_allow");
  });

  it("auto-executes a matching execute-rung policy", () => {
    const p = mkPolicy({ domain: "household", actionClass: "vendor.schedule", autonomy: "execute" });
    const d = evaluate(mkDeps({ policies: [p] }), {
      householdId: HH,
      request: mkRequest(),
    });
    expect(d.decision).toBe("auto_execute");
    expect(d.requiredRung).toBe("execute");
    expect(d.authorityId).toBe(p.id);
  });

  it("routes draft-rung to manager review", () => {
    const p = mkPolicy({ domain: "inbox", actionClass: "email.reply", autonomy: "draft" });
    const d = evaluate(mkDeps({ policies: [p] }), {
      householdId: HH,
      request: mkRequest({ domain: "inbox", actionClass: "email.reply" }),
    });
    expect(d.decision).toBe("manager_review");
    expect(d.requiredRung).toBe("draft");
  });

  it("routes ask-rung to customer approval", () => {
    const p = mkPolicy({ domain: "travel", actionClass: "flight.book", autonomy: "ask" });
    const d = evaluate(mkDeps({ policies: [p] }), {
      householdId: HH,
      request: mkRequest({ domain: "travel", actionClass: "flight.book" }),
    });
    expect(d.decision).toBe("customer_approval");
    expect(d.approver).toEqual({ type: "manager" });
  });

  it("routes to a specific principal when named as approver", () => {
    const p = mkPolicy({
      domain: "travel",
      actionClass: "flight.book",
      autonomy: "ask",
      approval: {
        conditions: [],
        fallbackApprover: "manager",
        approverPrincipalId: "prc_alice",
      },
    });
    const d = evaluate(mkDeps({ policies: [p] }), {
      householdId: HH,
      request: mkRequest({ domain: "travel", actionClass: "flight.book" }),
    });
    expect(d.approver).toEqual({ type: "principal", id: "prc_alice" });
  });

  it("skips a policy whose scope does not match", () => {
    const p = mkPolicy({
      domain: "travel",
      actionClass: "flight.book",
      autonomy: "execute",
      scope: { region: ["domestic"] },
    });
    const d = evaluate(mkDeps({ policies: [p] }), {
      householdId: HH,
      request: mkRequest({
        domain: "travel",
        actionClass: "flight.book",
        attrs: { region: "international" },
      }),
    });
    expect(d.decision).toBe("denied");
    expect(d.reasons).toContain("some_policies_out_of_scope");
  });

  it("explicit deny wins over allow", () => {
    const allow = mkPolicy({ domain: "household", actionClass: "vendor.schedule", autonomy: "execute" });
    const deny = mkPolicy({
      domain: "household",
      actionClass: "vendor.schedule",
      autonomy: "observe",
      effect: "deny",
      label: "no_vendor_scheduling_this_week",
    });
    const d = evaluate(mkDeps({ policies: [allow, deny] }), {
      householdId: HH,
      request: mkRequest(),
    });
    expect(d.decision).toBe("denied");
    expect(d.reasons.some((r) => r.startsWith("denied_by:"))).toBe(true);
  });

  it("escalates execute → ask when an escalation condition triggers", () => {
    const p = mkPolicy({
      domain: "travel",
      actionClass: "flight.book",
      autonomy: "execute",
      approval: {
        conditions: [{ kind: "attr_eq", key: "cabin", value: "first" }],
        fallbackApprover: "manager",
      },
    });
    const d = evaluate(mkDeps({ policies: [p] }), {
      householdId: HH,
      request: mkRequest({
        domain: "travel",
        actionClass: "flight.book",
        attrs: { cabin: "first" },
      }),
    });
    expect(d.decision).toBe("customer_approval");
    expect(d.requiredRung).toBe("ask");
    expect(d.reasons).toContain("escalation_triggered");
  });

  it("holds the per-action USD limit", () => {
    const p = mkPolicy({
      domain: "household",
      actionClass: "vendor.purchase",
      autonomy: "execute",
      limits: { perActionUsd: 250 },
    });
    const d = evaluate(mkDeps({ policies: [p] }), {
      householdId: HH,
      request: mkRequest({
        domain: "household",
        actionClass: "vendor.purchase",
        amountUsd: 500,
      }),
    });
    expect(d.decision).toBe("manager_review");
    expect(d.reasons.some((r) => r.startsWith("limit_per_action_usd_exceeded"))).toBe(true);
  });

  it("holds a rolling monthly limit using prior spend", () => {
    const p = mkPolicy({
      domain: "household",
      actionClass: "vendor.purchase",
      autonomy: "execute",
      limits: { perMonthUsd: 1000 },
    });
    const d = evaluate(mkDeps({ policies: [p], rollupAmount: 900 }), {
      householdId: HH,
      request: mkRequest({
        domain: "household",
        actionClass: "vendor.purchase",
        amountUsd: 150,
      }),
    });
    expect(d.decision).toBe("manager_review");
    expect(d.reasons.some((r) => r.startsWith("limit_month_usd_exceeded"))).toBe(true);
  });

  it("prefers a specific-subject policy over any_principal at the same rung", () => {
    const specific = mkPolicy({
      domain: "travel",
      actionClass: "flight.book",
      autonomy: "execute",
      subject: "prc_alice",
      label: "specific",
    });
    const generic = mkPolicy({
      domain: "travel",
      actionClass: "flight.book",
      autonomy: "execute",
      subject: "any_principal",
      label: "generic",
    });
    const d = evaluate(mkDeps({ policies: [generic, specific] }), {
      householdId: HH,
      request: mkRequest({
        domain: "travel",
        actionClass: "flight.book",
        subjectPrincipalId: "prc_alice",
      }),
    });
    expect(d.authorityId).toBe(specific.id);
  });

  it("respects the effective window", () => {
    const p = mkPolicy({
      domain: "household",
      actionClass: "vendor.schedule",
      autonomy: "execute",
      window: { effectiveFrom: "2027-01-01T00:00:00.000Z" },
    });
    const d = evaluate(mkDeps({ policies: [p] }), {
      householdId: HH,
      request: mkRequest(),
    });
    expect(d.decision).toBe("denied");
    expect(d.reasons).toContain("some_policies_out_of_window");
  });
});
