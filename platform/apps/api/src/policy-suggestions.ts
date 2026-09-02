import {
  approvalRepo,
  policyRepo,
  policySuggestionDismissalRepo,
  type Db,
} from "@atelier/db";
import {
  AUTONOMY_RANK,
  nowIso,
  type ApprovalItem,
  type HouseholdId,
  type Policy,
  type PolicyId,
  type PolicySpec,
} from "@atelier/domain";

// The autonomy ladder. When the same (action_class, subject) pattern
// gets approved N times in a row with no rejections in a rolling
// window, we surface a suggestion to promote the underlying policy to
// autonomy: "execute" — the agent then acts without a per-instance
// approval, but every action is still audited and the manager can
// revoke the promoted policy any time.
//
// The inverse — demotion — fires when an existing execute policy's
// escalated approvals get rejected or edited N times, meaning the
// policy is misconfigured and needs a manager check-in before every
// action again.
//
// The manager decides; we never auto-promote or auto-demote.
//
// See docs/33-permissions-and-autonomy.md §"Promotion loop".

export interface PromotionSuggestion {
  readonly kind: "promote";
  readonly actionClass: string;
  readonly domain: string;
  readonly subjectPrincipalId: string | null;
  readonly nApprovals: number;
  readonly windowDays: number;
  readonly currentRung: string;
  readonly suggestedRung: "execute";
  // The spec we'd create if the manager adopts. Cloned from the
  // most-recent authority policy with autonomy raised to "execute".
  readonly proposedPolicySpec: PolicySpec;
  // The approvals this suggestion is based on — most recent first.
  // Manager sees these in the console when reviewing.
  readonly basisApprovalIds: readonly string[];
  // Which policy the promotion is based on. Adopting creates a NEW
  // policy — we do not mutate the existing one. Same authority stays
  // in place so any audit trail that references it still resolves.
  readonly basisPolicyId: string;
  readonly basisPolicyLabel: string;
}

export interface DemotionSuggestion {
  readonly kind: "demote";
  readonly actionClass: string;
  readonly domain: string;
  readonly subjectPrincipalId: string | null;
  readonly nProblems: number;
  readonly windowDays: number;
  readonly currentRung: "execute" | "manage_autonomously";
  readonly suggestedRung: "draft";
  readonly proposedPolicySpec: PolicySpec;
  readonly basisApprovalIds: readonly string[];
  readonly basisPolicyId: string;
  readonly basisPolicyLabel: string;
  // Text summary of what the problem looks like — "3 rejections
  // in 60 days", etc. Rendered in the console next to the button.
  readonly summary: string;
}

export type PolicySuggestion = PromotionSuggestion | DemotionSuggestion;

export interface SuggestOpts {
  readonly threshold?: number;
  readonly demotionThreshold?: number;
  readonly windowDays?: number;
  readonly now?: Date;
}

const DEFAULT_THRESHOLD = 5;
const DEFAULT_DEMOTION_THRESHOLD = 3;
const DEFAULT_WINDOW_DAYS = 60;

// Group key for bucketing approvals — same action class + same
// subject principal. A pattern like "message.send" for two different
// customers is TWO patterns, not one; promoting for Alex says nothing
// about how the manager wants Bob's messages handled.
const bucketKey = (
  domain: string,
  actionClass: string,
  subjectPrincipalId: string | null,
): string => `${domain}::${actionClass}::${subjectPrincipalId ?? "_none"}`;
const key = (a: ApprovalItem): string =>
  bucketKey(a.domain, a.actionClass, a.subjectPrincipalId ?? null);

const subjectKey = (s: string | null): string => s ?? "_any";

export const computeSuggestions = (
  db: Db,
  householdId: HouseholdId,
  opts: SuggestOpts = {},
): PolicySuggestion[] => {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const demotionThreshold =
    opts.demotionThreshold ?? DEFAULT_DEMOTION_THRESHOLD;
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = opts.now ?? new Date();
  const windowStart = new Date(now.getTime() - windowDays * 86_400_000);

  const approvals = approvalRepo(db);
  const policies = policyRepo(db);
  const dismissals = policySuggestionDismissalRepo(db);

  // Pull the recent approval history. 500 is comfortably above the
  // threshold * (reasonable pattern count) for a single household —
  // if a household has more than 500 recent approvals the pattern
  // will still show, we just cap the scan.
  const recent = approvals.listAll(householdId, 500);
  const inWindow = recent.filter((a) => {
    if (!a.resolvedAt) return false;
    return new Date(a.resolvedAt) >= windowStart;
  });

  // Bucket by pattern. Within each bucket, most-recent first (that's
  // what listAll already returns, sorted by createdAt desc).
  const buckets = new Map<string, ApprovalItem[]>();
  for (const a of inWindow) {
    const k = key(a);
    const list = buckets.get(k) ?? [];
    list.push(a);
    buckets.set(k, list);
  }

  const existing = policies.list(householdId);
  // Existing standing policies with rung >= execute for the same
  // (household, action_class, subject) pattern short-circuit
  // promotion — no suggestion when there's already an auto-execute
  // policy in place. Track them by both specific-subject and
  // wildcard keys.
  const alreadyExecuting = new Set<string>();
  for (const p of existing) {
    if (AUTONOMY_RANK[p.spec.autonomy] < AUTONOMY_RANK.execute) continue;
    if (p.spec.effect !== "allow") continue;
    if (p.spec.kind !== "standing") continue;
    const subj = p.spec.subject;
    alreadyExecuting.add(
      `${p.spec.domain}::${p.spec.actionClass}::${subj === "any_principal" ? "*" : subj}`,
    );
  }
  const coversBucket = (bk: string): boolean => {
    if (alreadyExecuting.has(bk)) return true;
    const [domain, actionClass] = bk.split("::");
    return alreadyExecuting.has(`${domain}::${actionClass}::*`);
  };

  // Load dismissals; a dismissal hides a promotion suggestion until
  // the streak breaks. "Streak breaks" == any resolved approval in
  // the pattern with state != approved after the dismiss time.
  const dismissalRows = dismissals.list(householdId);
  const dismissalByBucket = new Map<
    string,
    { dismissedAt: string; approvalId: string }
  >();
  for (const d of dismissalRows) {
    // subject key sentinel _any comes back verbatim — turn it back
    // into "_none" to match the bucket key produced above.
    const subj = d.subjectPrincipalId === "_any" ? null : d.subjectPrincipalId;
    // Domain isn't stored on the dismissal row — dismissals key on
    // (action_class, subject) only, so a re-suggest carrying the
    // same class in a different domain (rare) would re-appear. Keep
    // scans by looking up dismissals in a shape that matches both
    // any_principal + specific subject entries via the domain-less
    // suffix.
    dismissalByBucket.set(`::${d.actionClass}::${subj ?? "_none"}`, {
      dismissedAt: d.dismissedAt,
      approvalId: d.dismissedAtApprovalId,
    });
  }
  const dismissedFor = (bk: string, list: readonly ApprovalItem[]) => {
    // bk == "domain::actionClass::subject" — strip the domain to
    // match the dismissal key.
    const [, actionClass, subj] = bk.split("::");
    const d = dismissalByBucket.get(`::${actionClass}::${subj}`);
    if (!d) return false;
    // If any non-clean approval in the pattern happened AFTER the
    // dismissal, the streak clearly broke and re-recovered — clear
    // the dismissal implicitly by ignoring it here.
    const brokenSinceDismiss = list.some(
      (a) =>
        a.resolvedAt !== undefined &&
        a.resolvedAt > d.dismissedAt &&
        a.state !== "approved",
    );
    return !brokenSinceDismiss;
  };

  const out: PolicySuggestion[] = [];

  // --- Promotion suggestions ---
  for (const [bk, list] of buckets) {
    if (list.length < threshold) continue;
    const window = list.slice(0, threshold);
    if (!window.every((a) => a.state === "approved")) continue;
    if (coversBucket(bk)) continue;
    if (dismissedFor(bk, list)) continue;

    const withAuthority = window.find((a) => a.authorityPolicyId);
    if (!withAuthority?.authorityPolicyId) continue;
    const basis = existing.find(
      (p) => p.id === withAuthority.authorityPolicyId,
    );
    if (!basis) continue;
    if (basis.spec.effect !== "allow") continue;
    if (basis.spec.kind !== "standing") continue;
    if (AUTONOMY_RANK[basis.spec.autonomy] >= AUTONOMY_RANK.execute) continue;

    const proposedPolicySpec: PolicySpec = {
      ...basis.spec,
      autonomy: "execute",
      label: `${basis.spec.label} — auto-execute (promoted)`,
    };

    out.push({
      kind: "promote",
      actionClass: withAuthority.actionClass,
      domain: withAuthority.domain,
      subjectPrincipalId: withAuthority.subjectPrincipalId ?? null,
      nApprovals: window.length,
      windowDays,
      currentRung: basis.spec.autonomy,
      suggestedRung: "execute",
      proposedPolicySpec,
      basisApprovalIds: window.map((a) => a.id),
      basisPolicyId: basis.id,
      basisPolicyLabel: basis.spec.label,
    });
  }

  // --- Demotion suggestions ---
  // An execute policy shouldn't produce approvals in the general
  // case — the agent just acts. But when escalation conditions fire
  // (amount_gt, attr_eq, etc.) the engine still routes to an
  // approval. If the MANAGER keeps overriding those escalations
  // (rejected / approved_with_edit), the policy's execute rung is
  // giving them work they don't want; demote to draft so it stops
  // firing on its own.
  const executePolicies = existing.filter(
    (p) =>
      p.spec.kind === "standing" &&
      p.spec.effect === "allow" &&
      AUTONOMY_RANK[p.spec.autonomy] >= AUTONOMY_RANK.execute,
  );
  for (const p of executePolicies) {
    // Collect approvals in the window that reference THIS policy
    // as authority. Filter by class + subject match so an unrelated
    // policy with the same auth id (shouldn't happen but be safe)
    // doesn't skew the count.
    const problems = inWindow.filter((a) => {
      if (a.authorityPolicyId !== p.id) return false;
      return a.state === "rejected" || a.state === "approved_with_edit";
    });
    if (problems.length < demotionThreshold) continue;

    // Rebuild the subject the demotion is scoped to. The spec's
    // subject may be a specific principal or the "any_principal"
    // wildcard; expose the wildcard case as null on the wire so it
    // matches the same shape promotion suggestions use.
    const subject =
      p.spec.subject === "any_principal" ? null : p.spec.subject;

    const proposedPolicySpec: PolicySpec = {
      ...p.spec,
      autonomy: "draft",
      label: `${p.spec.label} — reviewed manually (demoted)`,
    };

    out.push({
      kind: "demote",
      actionClass: p.spec.actionClass,
      domain: p.spec.domain,
      subjectPrincipalId: subject,
      nProblems: problems.length,
      windowDays,
      currentRung: p.spec.autonomy as "execute" | "manage_autonomously",
      suggestedRung: "draft",
      proposedPolicySpec,
      basisApprovalIds: problems.map((a) => a.id),
      basisPolicyId: p.id,
      basisPolicyLabel: p.spec.label,
      summary: `${problems.length} manager overrides in ${windowDays}d`,
    });
  }

  return out;
};

// Adopt a suggestion — creates a new policy from the suggestion spec.
// We do NOT mutate or revoke the basis policy; if the manager wants
// the old draft/ask policy gone, they revoke it separately. Keeping
// it lets us reconstruct why the promotion was made later.
export interface AdoptSuggestionInput {
  readonly householdId: HouseholdId;
  readonly kind?: "promote" | "demote";
  readonly actionClass: string;
  readonly subjectPrincipalId: string | null;
  readonly assertedBy: string;
}

export const adoptSuggestion = (
  db: Db,
  input: AdoptSuggestionInput,
  opts: SuggestOpts = {},
): { adopted: Policy } | { error: "no_such_suggestion" } => {
  const suggestions = computeSuggestions(db, input.householdId, opts);
  const match = suggestions.find(
    (s) =>
      s.actionClass === input.actionClass &&
      (s.subjectPrincipalId ?? null) === (input.subjectPrincipalId ?? null) &&
      // If a kind was requested, require it; otherwise any match wins
      // (backwards-compat with the old promotion-only shape).
      (!input.kind || s.kind === input.kind),
  );
  if (!match) return { error: "no_such_suggestion" };
  const adopted = policyRepo(db).create({
    householdId: input.householdId,
    spec: match.proposedPolicySpec,
    provenance: {
      source: "manager_observed",
      assertedBy: input.assertedBy,
      confidence: 1,
    },
    // Stamp the new policy with the chain of custody so a later
    // auditor can walk "why does this policy exist?" back to the
    // suggestion — and from there to the exact approvals that
    // earned a promotion or the misconfigured execute policy that
    // motivated a demotion.
    suggestionLineage: {
      kind: match.kind,
      basisPolicyId: match.basisPolicyId as PolicyId,
      basisApprovalIds: match.basisApprovalIds,
      suggestedAt: nowIso(),
    },
  });
  // On demotion, revoke the misconfigured execute policy — leaving
  // both live would be confusing (two conflicting rungs on the same
  // class + subject) and the manager's intent is clearly "this is no
  // longer the right rung". Promotion keeps the older policy in
  // place because it's a strict widening of authority, not a
  // correction.
  if (match.kind === "demote") {
    policyRepo(db).revoke(match.basisPolicyId as never);
  }
  return { adopted };
};

// Dismiss a promotion suggestion for a (class, subject) pattern.
// Persistent until the streak breaks (a rejection or edit in the
// window clears it implicitly — see dismissedFor above). Demotions
// aren't dismissible: an over-firing execute policy warrants
// visibility until it's either revoked or the pattern truly stabilises.
export interface DismissSuggestionInput {
  readonly householdId: HouseholdId;
  readonly actionClass: string;
  readonly subjectPrincipalId: string | null;
  readonly dismissedBy: string;
}

export const dismissSuggestion = (
  db: Db,
  input: DismissSuggestionInput,
  opts: SuggestOpts = {},
): { dismissed: true } | { error: "no_such_suggestion" } => {
  const suggestions = computeSuggestions(db, input.householdId, opts);
  const match = suggestions.find(
    (s) =>
      s.kind === "promote" &&
      s.actionClass === input.actionClass &&
      (s.subjectPrincipalId ?? null) === (input.subjectPrincipalId ?? null),
  );
  if (!match) return { error: "no_such_suggestion" };
  const headApprovalId = match.basisApprovalIds[0] ?? "";
  policySuggestionDismissalRepo(db).upsert({
    householdId: input.householdId,
    actionClass: input.actionClass,
    subjectPrincipalId: input.subjectPrincipalId,
    dismissedAtApprovalId: headApprovalId,
    dismissedBy: input.dismissedBy,
  });
  return { dismissed: true };
};

// Manual re-arm — clear a dismissal so the promotion suggestion
// can re-emerge without waiting for a rejection to reset it. Not
// wired to a route yet; here for symmetry.
export const clearDismissal = (
  db: Db,
  input: {
    householdId: HouseholdId;
    actionClass: string;
    subjectPrincipalId: string | null;
  },
): void => {
  policySuggestionDismissalRepo(db).clear(input);
  void subjectKey; // silence unused when clearDismissal isn't wired yet
};
