# Manager Console

The console is the Life Manager's operating system. It is not a
customer surface — customers never see it. Its job is to make one
manager as effective as a full traditional EA team, without letting
quality slip.

## Design commitments

1. **Time-to-triage is the north star.** Any item entering the
   manager's world should be resolvable (approved, edited, escalated,
   dispatched) in seconds for the common case.
2. **Never show a raw agent transcript by default.** The console
   presents *what the agent proposes to do* and *why*, with the trace
   available on demand. Managers read decisions, not chains of
   thought.
3. **The console is the audit trail for humans.** Every accept, edit,
   reject, override, and comment is logged and attributable.
4. **Capacity is a real number.** A manager has a measured capacity in
   household-load-units. The console shows it, and the routing engine
   respects it.
5. **Handoff is first-class.** Vacation, sickness, promotion, and
   attrition are inevitable. The console must make handoff between
   managers routine and safe.

## The top-level surfaces

The manager's day happens in five surfaces:

### 1. Inbox (per-household, prioritized)

The default view. One row per pending item, grouped by household,
ordered by SLA + risk. Every row shows:

- Household + principal.
- Item type (approval, exception, draft-to-send, customer message,
  agent question, proactive suggestion).
- One-line summary.
- Deadline / SLA clock.
- The three canonical actions relevant to the item type.

Keyboard-first. Bulk actions where safe.

### 2. Approvals

Items where the manager (or the customer via the manager) must
approve an agent-proposed action. Each approval card shows:

- The action, in a single sentence a human can act on.
- The **authority path**: which policy would authorize it, at which
  autonomy rung, with which limits.
- The **context bundle**: the specific graph facts the agent used
  (with confidence and provenance).
- The **alternatives**: what else the agent considered, briefly.
- The **cost surface**: dollar impact, calendar impact, downstream
  side effects.
- One-tap: Approve / Approve-with-edit / Reject / Escalate to
  customer / Ask agent to revise.

If the approval is bound for the customer, the console shows the
draft message that will be sent to the customer, editable in place.

### 3. Exceptions

Items where an agent failed, hit an ambiguity, or the outcome deviated
from expected. Exceptions are the manager's most valuable channel:
every exception either (a) gets resolved and closed, (b) generates a
policy or preference update to prevent recurrence, or (c) becomes a
product ticket for the agent's owning team.

Each exception carries:

- Trigger and the failing task.
- Diagnostic: transient / classification / policy gap / data gap /
  external system failure.
- Suggested resolution.
- One-tap: Resolve manually / Resolve and update policy / Resolve and
  update preference / Escalate to customer / File as product bug.

### 4. Household briefing

The single-page state of a household at a glance:

- Principals, members, staff, key contacts.
- Active obligations in the next 14/30/90 days.
- Recent actions (last 7 days) with outcomes.
- Open items (approvals, exceptions, drafts).
- Policy snapshot: autonomy per domain, spend rollups vs limits.
- The relationship: last customer touch, next planned touch,
  preference-of-communication reminders.

The briefing is designed to be read cold — a covering manager should
be able to pick up a household in under two minutes.

### 5. Customer channel

The manager's actual conversation with the customer: SMS, email, app.
Composition is agent-assisted (the drafts from the Draft/Ask rungs
land here pre-filled) but the manager owns every outgoing character.
No message leaves this surface without an explicit send.

Inside a household, activity for one person is consolidated into a
single per-customer timeline: SMS/WhatsApp/iMessage bubbles from
`messaging_events` and Gmail-synced email from `inbox_messages` are
joined via `contact_endpoints.principalId` (SMS) or fromAddress-
matching against the principal's email endpoints, then interleaved
by `receivedAt`. The raw stores stay separate — SMS carries consent
tracking, session windows, and delivery status; email carries Gmail
thread ids and inbox status — because merging them would either
flatten those or bloat one schema. `GET /households/:id/customers
/:principalId/activity` is the projection; the household page
renders one collapsible per person that lazy-loads on expand.
Downstream approvals are already consolidated in one table with
`origin` telling the manager which channel drove them.

Both halves of an email conversation land in the same store:
`inbox_messages` carries a `direction` column (inbound / outbound)
and a `toAddress`, and the Gmail sync pulls the INBOX label into
inbound rows and the SENT label into outbound rows via a `mailbox`
option on the sync call (`mailbox: "inbox" | "sent" | "both"`,
default inbox). Each mailbox owns its own history cursor
(`provider=gmail` for INBOX, `provider=gmail_sent` for SENT) so
their incremental deltas never crosstalk. The per-customer
timeline matches inbound rows by fromAddress against the
customer's email endpoints and outbound rows by toAddress — the
household's own Gmail is the sender on outbound, so
fromAddress matching would find nothing there.

Every per-customer panel ships with a reply composer that auto-
picks the channel from the last inbound message (SMS if the
customer last texted, email if they last emailed; falls back to
the first available endpoint). SMS routes through
`POST /messaging/send` and lands a `messaging_events` row; email
routes through `POST /messaging/send-email`, which reuses the
same Gmail helper the `message.send` agent tool uses, then
inserts a `direction=outbound` row into `inbox_messages` so the
timeline reflects the send immediately without waiting for the
next SENT sync. Opted-out SMS numbers refuse composition
locally; a household without a connected Gmail credential
refuses email sends with a `gmail_not_connected` message.

Email replies thread properly in both Gmail and non-Gmail
recipients. The Gmail sync extracts the RFC 5322 `Message-ID`
header (angle brackets stripped) and persists it on the
`inbox_messages` row alongside Gmail's own `externalThreadId`.
When the composer sends an email reply, it feeds the last
inbound email's Message-ID as `inReplyToRef` (rendered on the
wire as `In-Reply-To` + `References` headers so any MUA threads
it) and the `externalThreadId` as `threadId` (so the Gmail send
API places the reply in the same conversation server-side).
Every outbound also gets a freshly generated Message-ID header
persisted on its own row, so a customer replying downstream is
threaded back to the outbound.

## Cross-household attention feed

The `/dashboard` in the console is a manager-scoped view — approvals
plus a cross-household **attention feed**. A manager running 3-10
households needs one screen that surfaces "what's on fire, anywhere,
right now" without opening each household. The feed is powered by
`GET /me/attention` on the API; the same endpoint aggregates across
every household the calling manager has a live grant on and only
those. Managers without grants get an empty feed; non-manager actors
get an empty feed.

Four attention kinds today, ranked in this order:

1. **delivery_failure** — an outbound message we sent that the
   carrier (Twilio) marked `failed` or `undelivered` in the last 24h.
   Something we did didn't reach the customer; needs manager triage.
2. **frozen_household** — the household is frozen. Every agent action
   is shelved until unblocked; the manager needs to know they need
   to unfreeze (or that the freeze is still legitimate). One
   top-of-list card per frozen household.
3. **unread_thread** — an inbound customer message in the last 24h
   with no subsequent outbound to that endpoint. Customer said
   something and nobody's replied yet — manager or concierge agent.
4. **upcoming_obligation** — an `obligation.deadline` node whose
   `dueAt` lands in the next 14 days. Proactive nudge; the console
   doesn't wait for the deadline to arrive to surface it. Stale
   overdue items (30d+ past dueAt) are filtered out — they belong
   in the household drill-down, not the attention feed.

Within a kind, reactive items (delivery failures, unread threads,
frozen holds) sort newest-first — the most recent break is likely
the most urgent. Upcoming obligations sort ascending by `dueAt`
so what's due soonest floats up.

Every item carries `householdId` + `householdName` so the console
can render the drill-down link. The feed is a triage lane, not a
resolution surface: clicking through takes the manager to the
household page where the actual work happens.

## Item lifecycle

Every item on the manager's screen is one of:

```
new  →  in_progress  →  {resolved | escalated | deferred | product_bug}
```

- **new** — just arrived from the orchestrator.
- **in_progress** — the manager (or a covering manager) has claimed
  it. Claim is exclusive.
- **resolved** — closed with an outcome. Every resolution writes back
  to the graph.
- **escalated** — passed to the customer via the customer channel,
  waiting on customer response.
- **deferred** — parked with a resume time.
- **product_bug** — closed for the customer, opened as a ticket in the
  product tracker.

Deferred items resurface automatically. Escalated items resurface when
the customer replies or the SLA lapses.

## Capacity model

A household has a **load score**, computed continuously from:

- Volume of actions per week.
- Exception rate.
- Approval density.
- Communication cadence.
- Complexity signals (multiple properties, staff, dependents,
  travel frequency, business complexity).
- Tier.

A manager has a **capacity budget** in load-units. New households are
assigned only when the primary manager (and their backup) have budget
headroom. Load scores drive:

- Routing at assignment time.
- Fair rebalancing when a household's complexity grows.
- Compensation and staffing planning.
- The **customers-per-manager** metric (see below).

## Metrics the console must expose

Per household:

- Autonomous completion rate (target ↑ over customer lifetime).
- Manager intervention rate (target ↓).
- Approval-required rate (target: stable — this is a customer choice).
- Time-to-triage (median and p95).
- Time-to-completion by action class.
- Customer-decisions-required per week (target ↓; core value metric).
- Proactive-actions-initiated per week (target ↑).
- Graph completeness score (target ↑; leading indicator).
- Repeat-work automation rate (target ↑).
- NPS / trust proxy signals.
- Customer save rate on churn signals.

Per manager:

- Households under management.
- Load utilization vs. capacity.
- Median and p95 time-to-triage.
- Edit distance on agent drafts (proxy for agent quality in the
  manager's hands).
- Exception clear rate.
- Customer NPS attributable to this manager.

Per agent (aggregate across households):

- Proposal count.
- Autonomous execution count and success rate.
- Manager approval rate on drafts.
- Manager edit distance on drafts.
- Customer approval rate on Asks.
- Exception rate by cause.
- Cost per successful action.

The **autonomous completion rate** and **customer-decisions-required
per week** are the two headline numbers. The first drives the
economics; the second is the customer experience.

## Handoff

Every action supported by the console includes a handoff mode:

- **Planned handoff** (vacation, promotion) — outgoing manager
  produces a briefing note per household; the incoming manager
  co-shadows for a defined window; the customer is introduced by
  name before the transition.
- **Unplanned handoff** (sickness, resignation) — the backup manager
  is auto-activated; the customer is proactively notified with the
  covering manager's name and expected duration.
- **Permanent reassignment** — same as planned handoff, plus the
  customer's consent to the change of primary.

The household briefing view is the artifact that makes handoff work.
If it isn't good enough to hand over cold, the product is not ready
for scale.

## Access controls inside the console

Managers do not have unbounded access:

- A manager sees only their assigned households and the ones for
  which they are the named backup.
- Full graph access requires a household-level assignment; ad-hoc
  view is time-boxed and logged.
- Sensitive-topic material (health, legal, financial detail) is
  gated behind an additional per-view acknowledgment.
- Managers cannot modify policy on the customer's behalf — they can
  propose a policy change that the customer signs off on.
- All console reads and writes are logged to the customer's audit
  log with the manager's identity.

## Quality control

A distinct **QA layer** exists parallel to line operations:

- Random sampling of drafts, sends, and executed actions per
  manager per week.
- Rubric scoring: correctness, tone, completeness, adherence to
  household preferences.
- Feedback loop to the manager and to the agent owners.
- Trend surfacing: which action classes are drifting, which
  households are receiving inconsistent service, which agents are
  producing outsized manager edits.

QA reviewers see the same audit trail as line managers. Nothing is
hidden from oversight.

## What the console must not become

- A chat window with an LLM. That is not the manager's job.
- A place where policy is set inline in a hurry. Policy changes have
  their own path with customer sign-off.
- A place where the manager writes the graph directly. Managers
  confirm or reject candidates; they do not free-form edit facts
  outside the graph's provenance model.
- An admin panel. Household administration (billing, subscription,
  legal) lives elsewhere; the console is operational.
