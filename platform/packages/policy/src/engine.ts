import {
  AUTONOMY_RANK,
  nowIso,
  type ActionRequest,
  type AutonomyRung,
  type EscalationCondition,
  type HouseholdId,
  type Policy,
  type PolicyDecision,
  type PolicyId,
  type Domain,
} from "@atelier/domain";
import { scopeMatches } from "./scope.js";
import { dayStart, monthStart, weekStart } from "./limits.js";

// The dependencies the engine needs from storage. Kept as interfaces so
// the engine is trivially testable without spinning up a database.
export interface PolicySource {
  match(input: {
    householdId: HouseholdId;
    domain: Domain;
    actionClass: string;
    subjectPrincipalId: string;
  }): Policy[];
}

export interface RollupSource {
  amountRollup(
    householdId: HouseholdId,
    actionClass: string,
    range: { start: string; end: string },
  ): number;
  countRollup(
    householdId: HouseholdId,
    actionClass: string,
    range: { start: string; end: string },
  ): number;
}

export interface HouseholdFreezeSource {
  isFrozen(householdId: HouseholdId): boolean;
}

export interface EvaluatorDeps {
  readonly policies: PolicySource;
  readonly rollups: RollupSource;
  readonly household: HouseholdFreezeSource;
}

export interface EvaluateInput {
  readonly householdId: HouseholdId;
  readonly request: ActionRequest;
}

export const evaluate = (
  deps: EvaluatorDeps,
  input: EvaluateInput,
): PolicyDecision => {
  const nowStr = input.request.now ?? nowIso();
  const now = new Date(nowStr);
  const reasons: string[] = [];

  if (deps.household.isFrozen(input.householdId)) {
    return decision({
      decision: "shelved",
      requiredRung: "observe",
      reasons: ["household_frozen"],
      policiesChecked: [],
      evaluatedAt: nowStr,
    });
  }

  const matched = deps.policies.match({
    householdId: input.householdId,
    domain: input.request.domain,
    actionClass: input.request.actionClass,
    subjectPrincipalId:
      input.request.subjectPrincipalId === "any_principal"
        ? "any_principal"
        : input.request.subjectPrincipalId,
  });

  const checkedIds = matched.map((p) => p.id);

  const applicable = matched.filter((p) => inWindow(p, now));
  if (applicable.length < matched.length) reasons.push("some_policies_out_of_window");

  const scopeMatched = applicable.filter((p) => scopeMatches(p.spec.scope, input.request.attrs));
  if (scopeMatched.length < applicable.length) reasons.push("some_policies_out_of_scope");

  const deny = scopeMatched.find((p) => p.spec.effect === "deny");
  if (deny) {
    return decision({
      decision: "denied",
      requiredRung: "observe",
      authorityId: deny.id,
      reasons: [...reasons, `denied_by:${deny.spec.label}`],
      policiesChecked: checkedIds,
      evaluatedAt: nowStr,
    });
  }

  const allows = scopeMatched.filter((p) => p.spec.effect === "allow");
  if (allows.length === 0) {
    return decision({
      decision: "denied",
      requiredRung: "observe",
      reasons: [...reasons, "no_matching_allow"],
      policiesChecked: checkedIds,
      evaluatedAt: nowStr,
    });
  }

  // Pick the most-autonomous allow policy as the base authority. Ties
  // are broken by more-specific subject first, then by higher confidence.
  const ranked = [...allows].sort((a, b) => {
    const rankDelta = AUTONOMY_RANK[b.spec.autonomy] - AUTONOMY_RANK[a.spec.autonomy];
    if (rankDelta !== 0) return rankDelta;
    const subjectDelta =
      subjectSpecificity(b.spec.subject) - subjectSpecificity(a.spec.subject);
    if (subjectDelta !== 0) return subjectDelta;
    return b.provenance.confidence - a.provenance.confidence;
  });
  const authority = ranked[0]!;

  // Enforce limits against the picked authority. If limits fail, this
  // is a shelve (the request over-reaches the authority), not a deny.
  const limitViolations = evaluateLimits(deps.rollups, input, authority, now);
  if (limitViolations.length > 0) {
    return decision({
      decision: "manager_review",
      requiredRung: "ask",
      authorityId: authority.id,
      approver: { type: "manager" },
      reasons: [...reasons, ...limitViolations],
      policiesChecked: checkedIds,
      evaluatedAt: nowStr,
    });
  }

  // Determine final rung: base autonomy possibly demoted by an
  // escalation condition on the authority's approval config.
  // Escalation caps the rung at "ask" — if the policy would have
  // executed, the trigger forces a human in the loop; if it was
  // already ask/draft/observe, escalation leaves it alone. Using
  // min-rank here (not `rungAtLeast`, which would pick execute
  // over ask by rank) is what makes an escalation demote rather
  // than no-op.
  const escalated = escalationTriggered(authority.spec.approval.conditions, input.request);
  const finalRung: AutonomyRung = escalated
    ? AUTONOMY_RANK[authority.spec.autonomy] > AUTONOMY_RANK.ask
      ? "ask"
      : authority.spec.autonomy
    : authority.spec.autonomy;

  // Draft/Ask never truly auto-execute — they route to a human. Even if
  // this policy nominally allows execute, escalations that produce
  // "ask" degrade the decision correspondingly.
  if (escalated) reasons.push("escalation_triggered");

  return decision({
    decision: rungToDecision(finalRung),
    requiredRung: finalRung,
    authorityId: authority.id,
    approver: approverFor(finalRung, authority),
    reasons,
    policiesChecked: checkedIds,
    evaluatedAt: nowStr,
  });
};

// ─── helpers ───────────────────────────────────────────────────────

const inWindow = (p: Policy, now: Date): boolean => {
  const from = p.spec.window.effectiveFrom
    ? new Date(p.spec.window.effectiveFrom)
    : null;
  const to = p.spec.window.effectiveTo
    ? new Date(p.spec.window.effectiveTo)
    : null;
  if (from && now < from) return false;
  if (to && now >= to) return false;
  return true;
};

const subjectSpecificity = (subject: string): number =>
  subject === "any_principal" ? 0 : 1;

const evaluateLimits = (
  rollups: RollupSource,
  input: EvaluateInput,
  authority: Policy,
  now: Date,
): string[] => {
  const limits = authority.spec.limits;
  const violations: string[] = [];

  if (limits.perActionUsd !== undefined && input.request.amountUsd !== undefined) {
    if (input.request.amountUsd > limits.perActionUsd) {
      violations.push(
        `limit_per_action_usd_exceeded:${input.request.amountUsd}>${limits.perActionUsd}`,
      );
    }
  }

  const end = now.toISOString();
  const check = (
    windowName: string,
    range: { start: string; end: string },
    amountCap: number | undefined,
    countCap: number | undefined,
  ) => {
    if (amountCap !== undefined) {
      const spent = rollups.amountRollup(
        input.householdId,
        input.request.actionClass,
        range,
      );
      const proposed = input.request.amountUsd ?? 0;
      if (spent + proposed > amountCap) {
        violations.push(
          `limit_${windowName}_usd_exceeded:${(spent + proposed).toFixed(2)}>${amountCap}`,
        );
      }
    }
    if (countCap !== undefined) {
      const n = rollups.countRollup(
        input.householdId,
        input.request.actionClass,
        range,
      );
      if (n + 1 > countCap) {
        violations.push(`limit_${windowName}_count_exceeded:${n + 1}>${countCap}`);
      }
    }
  };

  check("day", { start: dayStart(now), end }, limits.perDayUsd, undefined);
  check("week", { start: weekStart(now), end }, limits.perWeekUsd, limits.perWeekCount);
  check("month", { start: monthStart(now), end }, limits.perMonthUsd, limits.perMonthCount);

  return violations;
};

const escalationTriggered = (
  conditions: EscalationCondition[],
  request: ActionRequest,
): boolean => {
  for (const c of conditions) {
    if (evaluateCondition(c, request)) return true;
  }
  return false;
};

const evaluateCondition = (
  c: EscalationCondition,
  request: ActionRequest,
): boolean => {
  switch (c.kind) {
    case "amount_gt":
      return (request.amountUsd ?? 0) > c.threshold;
    case "attr_eq":
      return equalsValue(request.attrs[c.key], c.value);
    case "attr_in":
      return c.values.some((v) => equalsValue(request.attrs[c.key], v));
    case "attr_present":
      return Object.prototype.hasOwnProperty.call(request.attrs, c.key);
  }
};

const equalsValue = (actual: unknown, expected: unknown): boolean => {
  if (Array.isArray(expected)) return expected.some((e) => e === actual);
  return actual === expected;
};

const rungToDecision = (
  r: AutonomyRung,
): "auto_execute" | "manager_review" | "customer_approval" | "shelved" => {
  switch (r) {
    case "execute":
    case "manage_autonomously":
      return "auto_execute";
    case "ask":
      return "customer_approval";
    case "draft":
    case "recommend":
      return "manager_review";
    case "observe":
      return "shelved";
  }
};

const approverFor = (
  rung: AutonomyRung,
  authority: Policy,
): PolicyDecision["approver"] => {
  if (rung === "ask") {
    const p = authority.spec.approval.approverPrincipalId;
    if (p) return { type: "principal", id: p };
    return { type: "manager" };
  }
  if (rung === "draft" || rung === "recommend") return { type: "manager" };
  return undefined;
};

const decision = (d: {
  decision: PolicyDecision["decision"];
  requiredRung: AutonomyRung;
  authorityId?: PolicyId;
  approver?: PolicyDecision["approver"];
  reasons: string[];
  policiesChecked: PolicyId[];
  evaluatedAt: string;
}): PolicyDecision => ({
  decision: d.decision,
  requiredRung: d.requiredRung,
  authorityId: d.authorityId,
  approver: d.approver,
  reasons: d.reasons,
  policiesChecked: d.policiesChecked,
  evaluatedAt: d.evaluatedAt,
});
