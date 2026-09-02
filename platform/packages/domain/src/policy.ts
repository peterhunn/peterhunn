import { z } from "zod";
import type { HouseholdId, PolicyId, ActionId, PrincipalId, ManagerId } from "./ids.js";
import { Provenance } from "./provenance.js";

// See docs/33-permissions-and-autonomy.md — authority is data, not code.

export const AutonomyRung = z.enum([
  "observe",
  "recommend",
  "draft",
  "ask",
  "execute",
  "manage_autonomously",
]);
export type AutonomyRung = z.infer<typeof AutonomyRung>;

// Ordered from least- to most-autonomous. Higher wins when combining
// stacked policies unless an escalation moves it back down toward ask/
// draft/observe.
export const AUTONOMY_RANK: Record<AutonomyRung, number> = {
  observe: 0,
  recommend: 1,
  draft: 2,
  ask: 3,
  execute: 4,
  manage_autonomously: 5,
};

export const rungAtLeast = (a: AutonomyRung, b: AutonomyRung): AutonomyRung =>
  AUTONOMY_RANK[a] >= AUTONOMY_RANK[b] ? a : b;

export const Domain = z.enum([
  "calendar",
  "inbox",
  "travel",
  "household",
  "family",
  "admin",
  "procurement",
  "communication",
  "financial",
  "documents",
  "research",
]);
export type Domain = z.infer<typeof Domain>;

export const SideEffectClass = z.enum([
  "read",
  "write_reversible",
  "write_irreversible",
  "financial",
  "communication",
]);
export type SideEffectClass = z.infer<typeof SideEffectClass>;

// Scope constraint values. A scalar or an array-of-scalars. If array,
// the action's attribute value must be in the array.
export const ScopeValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number(), z.boolean()])),
]);
export type ScopeValue = z.infer<typeof ScopeValue>;

export const Scope = z.record(ScopeValue);
export type Scope = z.infer<typeof Scope>;

export const Limits = z
  .object({
    perActionUsd: z.number().nonnegative().optional(),
    perDayUsd: z.number().nonnegative().optional(),
    perWeekUsd: z.number().nonnegative().optional(),
    perMonthUsd: z.number().nonnegative().optional(),
    perWeekCount: z.number().int().nonnegative().optional(),
    perMonthCount: z.number().int().nonnegative().optional(),
  })
  .default({});
export type Limits = z.infer<typeof Limits>;

// Escalation rules — when true, the policy requires customer approval
// even if its base autonomy would allow execute.
export const EscalationCondition = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("amount_gt"), threshold: z.number() }),
  z.object({ kind: z.literal("attr_eq"), key: z.string(), value: ScopeValue }),
  z.object({ kind: z.literal("attr_in"), key: z.string(), values: z.array(ScopeValue) }),
  z.object({ kind: z.literal("attr_present"), key: z.string() }),
]);
export type EscalationCondition = z.infer<typeof EscalationCondition>;

export const Approval = z
  .object({
    conditions: z.array(EscalationCondition).default([]),
    approverPrincipalId: z.string().optional(),
    fallbackApprover: z.enum(["manager", "none"]).default("manager"),
  })
  .default({ conditions: [], fallbackApprover: "manager" });
export type Approval = z.infer<typeof Approval>;

export const Window = z
  .object({
    effectiveFrom: z.string().datetime().optional(),
    effectiveTo: z.string().datetime().optional(),
  })
  .default({});
export type Window = z.infer<typeof Window>;

export const PolicyEffect = z.enum(["allow", "deny"]);
export type PolicyEffect = z.infer<typeof PolicyEffect>;

export const PolicyKind = z.enum(["standing", "one_time"]);
export type PolicyKind = z.infer<typeof PolicyKind>;

// Subject — who this policy applies to. "any_principal" is the household
// wildcard. A specific principal id constrains to that person.
export const PolicySubject = z.union([
  z.literal("any_principal"),
  z.string().startsWith("prc_"),
  z.string().startsWith("nod_"),
]);
export type PolicySubject = z.infer<typeof PolicySubject>;

export const PolicySpec = z.object({
  effect: PolicyEffect.default("allow"),
  kind: PolicyKind.default("standing"),
  subject: PolicySubject,
  domain: Domain,
  actionClass: z.string(),
  scope: Scope.default({}),
  autonomy: AutonomyRung,
  limits: Limits,
  approval: Approval,
  window: Window,
  oneTimeActionId: z.string().optional(),
  label: z.string(),
});
export type PolicySpec = z.infer<typeof PolicySpec>;

// When a policy was created by adopting an autonomy-ladder
// suggestion, this block records the chain-of-custody: which
// approvals (promotion) or which policy (demotion) motivated it.
// Written once at adopt time and never updated; the auditor's
// answer to "why does this execute policy exist?".
export interface PolicySuggestionLineage {
  readonly kind: "promote" | "demote";
  readonly basisPolicyId: PolicyId;
  readonly basisApprovalIds: readonly string[];
  readonly suggestedAt: string;
}

export interface Policy {
  readonly id: PolicyId;
  readonly householdId: HouseholdId;
  readonly spec: PolicySpec;
  readonly provenance: {
    readonly source: Provenance["source"];
    readonly assertedBy: string;
    readonly assertedAt: string;
    readonly confidence: number;
  };
  readonly createdAt: string;
  readonly revokedAt: string | undefined;
  readonly consumedByActionId: ActionId | undefined;
  readonly suggestionLineage: PolicySuggestionLineage | undefined;
}

// Requests from the caller (agent/manager/customer channel) to the
// engine. `attrs` is the free-form bag matched by the policy scope
// and by escalation conditions.
export const ActionRequest = z.object({
  subjectPrincipalId: z.union([z.literal("any_principal"), z.string()]),
  domain: Domain,
  actionClass: z.string(),
  sideEffectClass: SideEffectClass,
  attrs: z.record(z.unknown()).default({}),
  amountUsd: z.number().nonnegative().optional(),
  proposedBy: z.object({
    actor: z.string(),
    version: z.string().default("0"),
  }),
  now: z.string().datetime().optional(),
});
export type ActionRequest = z.infer<typeof ActionRequest>;

export type Decision =
  | "auto_execute"
  | "manager_review"
  | "customer_approval"
  | "shelved"
  | "denied";

export interface PolicyDecision {
  readonly decision: Decision;
  readonly requiredRung: AutonomyRung;
  readonly authorityId: PolicyId | undefined;
  readonly approver:
    | { readonly type: "principal"; readonly id: string }
    | { readonly type: "manager" }
    | undefined;
  readonly reasons: readonly string[];
  readonly policiesChecked: readonly PolicyId[];
  readonly evaluatedAt: string;
}

// Utilities used both by the engine and by the audit trail rendering
// on the manager side.
export const explainRung = (r: AutonomyRung): string => {
  switch (r) {
    case "observe":
      return "System only observes; nothing proposed to a human.";
    case "recommend":
      return "Agent surfaces options as background suggestions.";
    case "draft":
      return "Agent prepares a proposal; manager reviews and sends.";
    case "ask":
      return "Agent prepares a proposal; customer decides via manager.";
    case "execute":
      return "Agent executes autonomously; manager sees post-hoc.";
    case "manage_autonomously":
      return "Agent executes; only exceptions surface to a human.";
  }
};

export type { ManagerId, PrincipalId };
