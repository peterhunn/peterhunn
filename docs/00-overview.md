# ATELIER — Product & Architecture Spec

Codename: **ATELIER** (placeholder; final master brand TBD).
Category: **Life Management**.
Promise: **Life, managed.**

This directory is the internal build spec for the product and operating
system. It intentionally excludes brand, marketing, and pricing surface
area — those are addressed in separate documents.

## What this spec covers

| Doc | Scope |
| --- | --- |
| `00-overview.md` (this file) | System overview, glossary, invariants, build order. |
| [`22-knowledge-graph.md`](./22-knowledge-graph.md) | The Life Graph: entities, relationships, provenance, learning. |
| [`30-agents.md`](./30-agents.md) | Orchestrator + specialist agents, tool contracts, task lifecycle. |
| [`33-permissions-and-autonomy.md`](./33-permissions-and-autonomy.md) | Autonomy ladder, policy DSL, approvals, spend limits, audit. |
| [`31-manager-console.md`](./31-manager-console.md) | Human Life Manager console: queues, exceptions, quality, capacity. |
| [`32-customer-messaging.md`](./32-customer-messaging.md) | Concierge line: onboarding, profile linkage, TCPA consent, conversation memory. |
| [`23-data-model.md`](./23-data-model.md) | Storage, identity, encryption, tenancy, retention, portability. |
| [`24-model-routing.md`](./24-model-routing.md) | Model tiering, router, self-hosting policy, evals, cost controls. |
| [`10-operating-plan.md`](./10-operating-plan.md) | Phased operating plan: first 25 customers, hiring, SOPs, milestones. |
| [`11-business-model.md`](./11-business-model.md) | Tiers, pricing rules, unit economics, defensibility. |
| [`20-architecture.md`](./20-architecture.md) | Load-bearing engineering invariants — the code-level counterpart of this doc. |
| [`40-security.md`](./40-security.md) | Threat model + gap tracking, color-coded per surface. |

## System overview

At the highest level, ATELIER is three things stacked:

1. **A Life Graph** — a per-household, persistent, permissioned model of
   the customer's people, assets, obligations, preferences, documents,
   vendors, and policies.
2. **A fleet of software agents** — an orchestrator plus specialist
   agents (calendar, inbox, travel, household, family, admin,
   procurement, research, documents) that read from and write to the
   Life Graph and act through integrations.
3. **A human Life Manager** — a named person accountable for the
   relationship, exception handling, judgment calls, and quality of
   every outcome. The manager supervises the agents; the customer does
   not.

The customer interacts with the manager. The manager interacts with the
console. The console orchestrates the agents. The agents read/write the
Life Graph and call tools.

```text
Customer <-> Life Manager <-> Manager Console <-> Orchestrator
                                                     |
                                    +----------------+-----------------+
                                    |                                  |
                              Specialist Agents  <---read/write--->  Life Graph
                                    |
                              Tools / Connectors / APIs
```

## Invariants (do not violate)

These are hard rules the system must enforce structurally, not by
convention:

1. **Every material action is auditable.** No agent action reaches an
   external system without a durable record: who initiated, what
   authority was used, what inputs, what outputs, what customer
   approval (if any).
2. **Authority is data, not code.** What an agent may do — for a
   particular customer, in a particular domain, at a particular dollar
   threshold — is stored in the Life Graph as policy. Agents cannot
   act outside stored policy, ever.
3. **The manager can always intervene.** Any queued or in-flight
   agent action can be paused, edited, or overridden by the assigned
   Life Manager. There is no "the agent already sent it, sorry" state
   for anything that isn't atomic at the tool boundary.
4. **Nothing is silently learned from a single event.** Preference and
   policy updates written back to the graph require either (a) a
   confirmed pattern (see [`22-knowledge-graph.md`](./22-knowledge-graph.md) on learning) or (b)
   explicit manager confirmation. One-shot inferences are stored as
   candidates, not as truth.
5. **Two identities, always distinct.** Actions taken *on behalf of*
   the customer (via delegated access) are cryptographically and
   auditably distinguishable from actions taken *by* the customer.
6. **Household-scoped, not user-scoped.** A customer is a household or
   an individual acting as a household of one. The graph, permissions,
   and audit trail are always household-scoped; per-person views are
   projections.
7. **One life.** There is no "work" vs. "home" partition in the data
   model. Domains (calendar, inbox, travel) are agent-facing labels;
   the graph is unified.

## Glossary

- **Household** — the tenancy boundary. A customer subscribes as a
  household. Multiple people (principal, spouse, children, staff) may
  have distinct roles within it.
- **Principal** — the person(s) with decision authority in a household.
  A household has ≥1 principal.
- **Life Manager** — the named human accountable for the household.
  One primary; may have a backup manager for continuity.
- **Life Graph** — the household's private knowledge graph.
- **Orchestrator** — the top-level agent that decomposes intents into
  agent tasks and manages their lifecycle.
- **Specialist agent** — a domain-scoped agent (Calendar, Travel, etc).
- **Tool** — a bounded, typed operation an agent can invoke: an API
  call, a booking, a message send, a document parse, a search.
- **Action** — a proposed or completed operation with side effects
  outside the system (a booking, a send, a purchase). Actions have
  authority, approval state, and audit records.
- **Policy** — stored authority that says which principal, in which
  domain, may authorize which class of action up to which limit,
  autonomously or with approval.
- **Autonomy level** — where a class of action sits on the
  Observe→Recommend→Draft→Ask→Execute→Manage-Autonomously ladder for a
  specific household.

## Build order

The concierge-first thesis in the brief drives the sequence. Software
follows demonstrated demand.

**Phase 0 — Manual with instrumentation.** Ship the manager console and
the Life Graph. No agents. Managers do everything by hand; every action
is logged into the graph and console so we learn what recurs.

**Phase 1 — Assistive agents.** Introduce Inbox and Calendar agents in
Draft/Ask mode only. Managers edit and send. Measure edit distance and
approval rate.

**Phase 2 — Executing agents.** Promote high-confidence, low-risk
action classes (restaurant reservations, calendar reshuffles under a
threshold, routine vendor scheduling) to Execute for households whose
policy allows it.

**Phase 3 — Proactive agents.** Introduce the proactive layer that
scans the graph for upcoming obligations (expirations, renewals,
maintenance windows) and initiates work.

**Phase 4 — Cross-domain orchestration.** The "we're going to London for
two weeks in October" experience. Requires that Phases 1–3 in
calendar, travel, household, and family are individually reliable.

No phase begins until the prior phase's autonomous completion rate,
approval rate, and manager intervention rate meet targets defined in
[`31-manager-console.md`](./31-manager-console.md).

## Non-goals (for now)

- A customer-facing chat surface as the primary interaction. Customers
  reach their manager through a small set of channels (SMS, email, a
  simple app). The chat *with the manager* may be agent-assisted, but
  it is not an "AI assistant" surface.
- A public API or developer platform.
- Multi-manager pooling (a customer talking to whoever is on shift).
  Every household has a named primary.
- Selling data, ads, or referrals. Vendor selection is on behalf of
  the customer, full stop.
