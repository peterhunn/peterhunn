import {
  approvalRepo,
  policyRepo,
  type Db,
} from "@atelier/db";
import {
  AUTONOMY_RANK,
  type ApprovalItem,
  type HouseholdId,
  type Policy,
  type PolicySpec,
} from "@atelier/domain";

// The autonomy ladder. When the same (action_class, subject) pattern
// gets approved N times in a row with no rejections in a rolling
// window, we surface a suggestion to promote the underlying policy to
// autonomy: "execute" — the agent then acts without a per-instance
// approval, but every action is still audited and the manager can
// revoke the promoted policy any time.
//
// A suggestion is computed on demand — no new table. Storage is the
// approval log itself. The manager decides; we never auto-promote.
//
// See docs/33-permissions-and-autonomy.md §"Promotion loop".

export interface PolicySuggestion {
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

export interface SuggestOpts {
  readonly threshold?: number;
  readonly windowDays?: number;
  readonly now?: Date;
}

const DEFAULT_THRESHOLD = 5;
const DEFAULT_WINDOW_DAYS = 60;

// Group key for bucketing approvals — same action class + same
// subject principal. A pattern like "message.send" for two different
// customers is TWO patterns, not one; promoting for Alex says nothing
// about how the manager wants Bob's messages handled.
const key = (a: ApprovalItem): string =>
  `${a.domain}::${a.actionClass}::${a.subjectPrincipalId ?? "_none"}`;

export const computeSuggestions = (
  db: Db,
  householdId: HouseholdId,
  opts: SuggestOpts = {},
): PolicySuggestion[] => {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = opts.now ?? new Date();
  const windowStart = new Date(now.getTime() - windowDays * 86_400_000);

  const approvals = approvalRepo(db);
  const policies = policyRepo(db);

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

  // Existing standing policies with rung >= execute for the same
  // (household, action_class, subject) pattern short-circuit — no
  // suggestion when there's already an auto-execute policy in place.
  const existing = policies.list(householdId);
  const alreadyExecuting = new Set<string>();
  for (const p of existing) {
    if (AUTONOMY_RANK[p.spec.autonomy] < AUTONOMY_RANK.execute) continue;
    if (p.spec.effect !== "allow") continue;
    if (p.spec.kind !== "standing") continue;
    // Both a specific principal subject and "any_principal" cover
    // any bucket for that principal, so add both keys.
    const subj = p.spec.subject;
    alreadyExecuting.add(
      `${p.spec.domain}::${p.spec.actionClass}::${subj === "any_principal" ? "*" : subj}`,
    );
  }
  const coversBucket = (bucketKey: string): boolean => {
    if (alreadyExecuting.has(bucketKey)) return true;
    // Also check the wildcard form of this bucket — a policy on
    // "any_principal" for the same action_class covers every subject.
    const [domain, actionClass] = bucketKey.split("::");
    return alreadyExecuting.has(`${domain}::${actionClass}::*`);
  };

  const out: PolicySuggestion[] = [];
  for (const [bucketKey, list] of buckets) {
    if (list.length < threshold) continue;
    const window = list.slice(0, threshold);
    // All N most recent in this pattern must be a clean "approved" —
    // rejections, expirations, or manager edits break the streak
    // because they mean the manager wasn't fully happy with the
    // agent's proposal at that step.
    if (!window.every((a) => a.state === "approved")) continue;
    if (coversBucket(bucketKey)) continue;

    // Pick the most recent approval that references a policy id. The
    // authority policy is what got the approval OK'd in the first
    // place; we clone its spec and raise the autonomy so the agent
    // acts directly on the same guardrails going forward.
    const withAuthority = window.find((a) => a.authorityPolicyId);
    if (!withAuthority?.authorityPolicyId) continue;
    const basis = existing.find(
      (p) => p.id === withAuthority.authorityPolicyId,
    );
    if (!basis) continue;
    if (basis.spec.effect !== "allow") continue;
    if (basis.spec.kind !== "standing") continue;
    // Already at execute or above (belt-and-braces — the alreadyExecuting
    // scan should have caught it, but the covering-scope match uses
    // just (domain, actionClass, subject) so an execute policy that
    // matches a broader subject via any_principal is fine).
    if (AUTONOMY_RANK[basis.spec.autonomy] >= AUTONOMY_RANK.execute) continue;

    const proposedPolicySpec: PolicySpec = {
      ...basis.spec,
      autonomy: "execute",
      label: `${basis.spec.label} — auto-execute (promoted)`,
    };

    out.push({
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

  return out;
};

// Adopt a suggestion — creates a new policy from the suggestion spec.
// We do NOT mutate or revoke the basis policy; if the manager wants
// the old draft/ask policy gone, they revoke it separately. Keeping
// it lets us reconstruct why the promotion was made later.
export interface AdoptSuggestionInput {
  readonly householdId: HouseholdId;
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
      (s.subjectPrincipalId ?? null) === (input.subjectPrincipalId ?? null),
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
  });
  return { adopted };
};
