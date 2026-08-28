# Permissions, Policy & Autonomy

Authority in ATELIER is data. Every question of the form "may this
agent do this thing for this household right now?" is answered by the
policy engine reading policy nodes from the Life Graph. No
authorization logic lives inside an agent.

This is the file where a customer's trust is codified.

## The autonomy ladder

Every class of action, for every household, sits at exactly one rung:

| Rung | Meaning | Who acts | Who approves |
| --- | --- | --- | --- |
| 1. Observe | System watches, records, learns. No proposals surface. | — | — |
| 2. Recommend | Agent surfaces options to the manager as background suggestions. | Manager (optional) | — |
| 3. Draft | Agent prepares a concrete proposal (message, booking, schedule change). | Manager (edits/sends) | Manager |
| 4. Ask | Agent prepares a proposal and asks the customer directly (via the manager channel). | Customer decides | Customer |
| 5. Execute | Agent executes autonomously; manager sees it in the ledger. | Agent | Auto (post-hoc audit) |
| 6. Manage autonomously | Agent executes and only surfaces exceptions. | Agent | Auto (exception-triggered) |

Rung 4 (Ask) is only used when the customer is the appropriate
decider. Rung 5 (Execute) is only used when the customer has granted
standing authority and the action is within policy.

Every household starts, by default, at Rung 3 (Draft) for
communication, Rung 2 (Recommend) for financial, and Rung 5 (Execute)
only for narrowly-scoped, low-risk domains (e.g., restaurant
reservations under a table size threshold).

## The policy DSL

Policies are stored graph nodes with the following shape:

```yaml
id: pol_household42_travel_domestic_business
household: household42
subject: principal_alice          # or "any_principal" | "member:child_ref"
domain: travel                    # calendar | inbox | travel | household | family | admin | procurement | communication | financial | documents
action_class: flight.book         # tool-defined; see agents.md
scope:
  region: domestic
  cabin: [economy_plus, business]
  refundable_only: false
  loyalty_only_when_available: true
autonomy: execute                 # one of the six rungs
limits:
  per_action_usd: 3500
  per_month_usd: 20000
  per_week_count: 3
approval:
  required_when:
    - per_action_usd > 3500
    - cabin == first
    - international == true
  approver: principal_alice
  fallback_approver: manager      # for time-sensitive fallback, still audited
window:
  effective_from: 2026-01-01
  effective_to: null
  quiet_hours: [22:00-07:00 local_to_principal]
provenance:
  established_by: principal_alice
  established_at: 2026-01-15T14:03:00Z
  established_via: onboarding_interview
  witnessed_by: manager_jones
audit: full
```

Key properties:

- **Additive by default; explicit deny wins.** Multiple policies may
  match an action; the most-restrictive resolution applies. A
  `deny` policy always overrides an `allow`.
- **Standing vs. one-time.** Standing policies (like the above) grant
  ongoing authority. One-time policies grant authority for a single
  action id and expire on use.
- **Household + subject scoped.** Never global. A policy for
  "any_principal" still means "any principal *of household42*".
- **Time-bounded.** Every policy may carry an effective window.
  Onboarding-era permissive policies can be set to expire and force
  a re-review.

## The evaluation flow

When an agent enters `proposing_action`, the policy engine runs:

```
1. Load all policies where (household, subject, domain, action_class) match.
2. Filter by window (effective now? quiet hours?).
3. Apply scope filters (region, size, refundability, etc.).
4. Compute rollups: per-action, per-month, per-week from action ledger.
5. Determine required autonomy rung:
      max(policy.autonomy, escalations from approval.required_when)
6. If Execute → dispatch to tool with authority = policy.id
   If Ask → route to customer via manager
   If Draft/Recommend → route to manager
   If Observe → shelve
7. Write policy_check record to task ledger, always.
```

Every action carries the `authority_id` of the policy that permitted
it. If a policy is later revoked or modified, actions taken under it
are still attributable.

## Communication policy is special

Sending a message *from* the customer *to* a third party is a high-
trust operation and gets its own axis:

- **Recipient class.** Family / friend / staff / vendor / employer /
  counsel / medical / regulator. Different rungs per class.
- **Channel.** SMS / email / DM / letter / voice.
- **Tone envelope.** Formal / neutral / warm / urgent. Agents draft
  within the household's established voice profile.
- **Standing approvals.** "Any confirmation-of-appointment email under
  50 words to a known vendor is Execute." "Anything to counsel is
  Draft." "Anything to the employer is Ask."
- **Sensitive topic flags.** Health, legal, financial, disciplinary,
  and household-personnel topics are always Ask, regardless of
  recipient policy.

The manager can always override upward (require more approval than
policy demands). The manager cannot override downward (execute
something policy does not permit) without the customer opening the
authority.

## Financial policy

Financial actions have a compounding authority model:

- **Per-action limit** — dollar cap per single action.
- **Rolling window limits** — per day/week/month/quarter/year.
- **Vendor class limits** — separate rails for household
  services vs. travel vs. procurement vs. gifts.
- **Payment method binding** — a policy names the payment methods
  it may draw from. An action attempting a different method fails.
- **Standing authority timeout.** Financial authority always has a
  hard expiry (default 12 months) forcing periodic re-consent.

Financial policy is the one place where "execute" almost always
carries a rollback plan: for reversible instruments (holds,
soft-bookings), the plan is described; for irreversible ones (a
purchase), the customer's acknowledgment of irreversibility is a
policy precondition.

## Approvals

An action requiring approval enters an approval queue with:

- **Approver** — principal (usually) or fallback (rare).
- **Deadline** — soft (SLA) and hard (auto-cancel).
- **Reversibility window** — how late an approved action can be
  undone.
- **Context bundle** — everything the approver needs on one screen.
- **Trigger** — the origin of the run that produced the proposal.
  Denormalised onto the approval row itself (`origin` +
  `originBy`) so the manager sees whether a draft was kicked off
  by the customer texting in, another manager acting on their
  behalf, the autopilot processing a fresh inbox message, or a
  system playbook, without a second query. The full run row
  remains the source of truth, still reachable by `runId`.
- **Explicit choices** — Approve / Approve with edit / Reject / Ask
  the manager.

Approvals arrive through the manager channel (SMS/email/app), never as
raw agent output. The customer answers a manager; the manager relays
to the system.

## Audit

Every action, whether autonomous or approved, produces:

- `action_id`, `household_id`, `principal_id`, `agent`, `agent_version`.
- `tool`, `tool_version`, `inputs_hash`, `outputs_hash`.
- `policy_ids_checked`, `policy_id_authorizing`, `evaluation_trace`.
- `approver_id` (if any), `approval_channel`, `approval_evidence`.
- `graph_reads_summary`, `graph_writes_summary`.
- `outcome` (`succeeded` | `failed_transient` | `failed_permanent` |
  `rolled_back`).
- `customer_visible_summary` — a one-line human-readable description.

The audit log is append-only, per-household, and exportable. Every
customer can, on request, get a full log of every action taken for
them.

## Revocation and freeze

Two customer-facing controls that bypass everything:

1. **Revoke authority.** The customer or manager can revoke any
   policy immediately. In-flight actions authorized by it are
   halted where possible and rolled back where reversible.
2. **Household freeze.** A single control that puts the entire
   household into Observe mode across all domains. New intents are
   captured but not acted on. Existing scheduled actions are
   suspended. This is the "stop" button; it must never be more than
   one click deep.

## Onboarding starting posture

New households begin with the following default policy set. Managers
tune during onboarding; the customer signs off.

| Domain | Default rung |
| --- | --- |
| Observation of calendar/inbox | Observe |
| Draft replies (any) | Draft |
| Restaurant reservations ≤ 6 people | Execute |
| Calendar changes ≤ 30 min, same day | Execute |
| Calendar changes > 30 min or cross-day | Ask |
| Household vendor scheduling (established vendors) | Execute |
| Household vendor selection (new vendor) | Ask |
| Household purchase ≤ $250 | Execute |
| Household purchase $250–$1,000 | Ask |
| Household purchase > $1,000 | Approval |
| Domestic flight, economy | Ask |
| Any international travel | Approval |
| Any financial account change | Approval |
| Any communication to employer | Ask |
| Any communication to counsel/medical | Draft |
| Anything flagged sensitive-topic | Ask |

Progressive autonomy is a customer choice, not a system push. A
household that never wants to leave Draft/Ask should experience the
service as equally proactive; the difference is where the approval
lands.

## Promotion loop (autonomy ladder suggestions)

The manager doesn't have to guess when a policy is ready to move up
the ladder. When the same `(action_class, subject_principal_id)`
pattern is approved cleanly N times in a row within a rolling
window (default: 5 approvals, 60 days), the API surfaces a
**suggestion** to promote the underlying policy's autonomy to
`execute`. The suggestion is a proposal — nothing changes until the
manager adopts it.

Rules the suggestion engine follows:

- Only clean approvals count. `approved_with_edit`, `rejected`,
  `expired`, and `canceled` break the streak — a manager who edited
  the agent's proposal wasn't fully satisfied, and that signal is
  worth more than the raw approval count.
- Suggestions never appear if an `execute` (or higher) policy
  already covers the pattern. A more-specific policy on
  `any_principal` for the same action class also counts as coverage.
- The suggested spec is cloned from the most recent authority
  policy that OK'd an approval in the streak. Escalation conditions,
  limits, and scope carry over verbatim; only `autonomy` is raised.
  A message-send policy that escalates on
  `attr_in employer/counsel/medical` keeps that escalation after
  promotion — so "auto-execute" still asks for approval on the
  sensitive slice.
- Adopting a suggestion creates a **new** policy; the old
  draft/ask policy is left in place. If the manager wants the older
  version revoked, they revoke it separately. This preserves the
  audit trail — any historical action that cited the older policy
  still resolves.

Endpoints:

- `GET /households/:id/policies/suggestions` — returns
  `{ suggestions: [{ actionClass, subjectPrincipalId, nApprovals,
  windowDays, currentRung, suggestedRung, proposedPolicySpec,
  basisApprovalIds, basisPolicyId, basisPolicyLabel }] }`. Optional
  `?threshold=N&windowDays=N` overrides.
- `POST /households/:id/policies/suggestions/adopt` — body
  `{ actionClass, subjectPrincipalId }` — creates the promoted
  policy and returns `{ policy }`. Returns 404 when the named
  pattern is not currently suggested (e.g., a rejection landed in
  the window since the suggestion was computed).

The promotion loop only ever raises autonomy toward `execute`; it
never suggests `manage_autonomously`, and it never proposes new
subjects or new action classes. It's a paved path for "this pattern
has proven itself", not a replacement for manager judgement.
