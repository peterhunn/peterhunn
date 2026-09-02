# Agent Architecture

Agents are the execution layer. They read from and write to the Life
Graph, call tools, and produce actions. They do not decide their own
authority — the policy engine ([`33-permissions-and-autonomy.md`](./33-permissions-and-autonomy.md)) does that. They do
not decide their own quality bar — the manager console
([`31-manager-console.md`](./31-manager-console.md)) does that.

## Design commitments

1. **Agents are workers, not deciders.** An agent proposes an action.
   The policy engine decides whether it may execute autonomously,
   requires manager approval, or requires customer approval.
2. **Agents are stateless between tasks.** All durable state lives in
   the Life Graph. An agent instance is a function of (task, graph
   snapshot, tool set). This makes them replayable, testable, and
   swappable.
3. **Tools are typed contracts, not free API calls.** An agent cannot
   invoke a raw HTTP call. Every side-effecting operation is mediated
   by a Tool with declared inputs, outputs, side-effect class, and
   audit hooks.
4. **Every agent step is recorded.** The task ledger captures inputs,
   graph reads, tool calls, tool responses, graph writes, and outputs.
   Replay is a first-class debugging surface.
5. **No agent talks directly to the customer.** All customer-facing
   communication routes through the manager (who may accept a draft
   verbatim, edit, or reject). This is a hard invariant during Phases
   0–3.

## The orchestrator

The Orchestrator is the top-level agent. Its job:

- Accept an **intent** — either a customer message forwarded by the
  manager, an internal trigger (a graph-derived obligation), or a
  scheduled proactive scan.
- Decompose the intent into **tasks** for specialist agents.
- Assemble the results into a coherent **response** (a draft message,
  an approval request, an executed action, or a queued item).
- Route the response to the manager console.

The orchestrator is not "the smart one" — it is the planner and the
router. Specialist agents own domain reasoning.

### Intent → task decomposition

Intents carry: household id, principal id, source (customer/manager/
trigger/schedule), text (if any), attachments (if any), and a graph
snapshot cursor.

The orchestrator produces a **task DAG**: a directed acyclic graph of
tasks with dependencies. Example, for "we're going to London for two
weeks in October":

```text
resolve_dates ──► check_conflicts ──┐
                                    ├──► propose_travel ──► approvals
resolve_travelers ──► travel_docs ──┘
resolve_travelers ──► family.school_coverage
resolve_travelers ──► family.childcare_coverage
resolve_dates ──► household.services_hold
resolve_dates ──► calendar.reshuffle
```

Tasks are dispatched in dependency order. Failed tasks may be retried,
substituted, or escalated to the manager. Partial success is normal.

## Specialist agents

Each specialist owns a domain: a slice of the graph it primarily reads
and writes, and a bounded set of tools. Agents are versioned; multiple
versions may run behind a feature flag per household.

| Agent | Reads primarily | Writes primarily | Tool families |
| --- | --- | --- | --- |
| **Calendar** | `person`, `obligation`, `preference.communication` | `obligation.appointment`, `action` | calendar providers, video meeting |
| **Inbox** | mail store pointers, `person.contact`, `obligation` | `obligation`, `action`, `interaction` | mail providers, extraction |
| **Travel** | `preference.travel`, `person`, `document.identity`, `asset.membership` | `obligation.appointment`, `action` | airlines, hotels, ground, GDS, loyalty |
| **Household** | `place.property`, `asset.equipment`, `org.vendor`, `preference.vendor` | `obligation.recurring`, `action` | vendor CRMs, scheduling, messaging |
| **Family** | `person.member`, `org.school`, `obligation.deadline` | `obligation`, `action` | school portals, activity providers |
| **Admin** | `document.*`, `obligation.deadline`, `asset.membership` | `document`, `obligation`, `action` | filing, forms, reimbursements |
| **Procurement** | `preference.*`, `policy` (spend) | `action` (with financial side effect) | retailers, marketplaces, quotes |
| **Research** | broad; low write | `action` (informational), draft nodes | web, provider databases |
| **Documents** | raw files, `document.*` | `document.*`, extracted facts | OCR, extraction, classification |
| **Proactive** | `obligation.*`, `document.*.expires_at` | intents (feeds back to Orchestrator) | none directly; produces intents |

The Proactive agent is special: it produces intents, not actions. It
runs on a schedule against the graph and detects obligations,
expirations, and precedent-matched recurring needs, then hands them to
the orchestrator like any other intent.

## Task lifecycle

Every task moves through a small state machine:

```
   received
      │
      ▼
   planning ──► blocked (waiting on dependency, human, or external)
      │              │
      ▼              ▼
   executing ◄──── unblocked
      │
      ▼
   proposing_action ──► policy_check
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        auto_execute    manager_review  customer_approval
              │              │              │
              └──────────────┼──────────────┘
                             ▼
                          completed / rejected / failed
                             │
                             ▼
                        graph_writeback
```

- **planning** is the agent's internal decomposition/reasoning.
- **executing** is graph reads + tool calls with no external side
  effects (searches, quotes, availability checks).
- **proposing_action** is the point at which the agent has a concrete
  side-effecting operation to run and hands it to the policy engine.
- **graph_writeback** is unconditional on completion or rejection —
  we always learn from the outcome.

## Tool contract

A tool is defined by:

```yaml
name: hotel.search
version: 2
inputs:
  destination: place | address_string
  window: date_range
  travelers: [person_ref]
  constraints: preference.travel | override_block
outputs:
  candidates: [hotel_candidate]     # non-side-effecting
side_effect_class: read              # read | write_reversible | write_irreversible | financial | communication
authority_required: none             # none | policy_class:<class>
audit: full
rate_limits: {...}
```

Side-effect classes drive policy:

- `read` — no policy check.
- `write_reversible` — cancellable within a defined window (a hold, a
  soft reservation). Requires domain policy check.
- `write_irreversible` — cannot be undone by the system (a purchase, a
  sent message). Requires domain + risk policy check.
- `financial` — moves money. Requires financial policy check and spend
  authority.
- `communication` — sends a message from the customer or manager to a
  third party. Requires communication policy check and, until Phase 3+,
  manager sign-off.

Agents may only invoke tools whose contract they hold. New tools are
registered centrally, reviewed for side-effect class, and rolled out
per-agent, per-household.

## Determinism, retries, idempotency

Every action carries a client-generated **idempotency key** derived
from (task id, tool name, canonicalized inputs). The tool layer
enforces at-most-once semantics against downstream systems that
support it, and detects duplicates against those that don't (by
storing outbound-request fingerprints).

Retries at the agent layer are only permitted for classified
transient failures. Non-transient failures escalate to the manager
with the full task trace.

## Multi-agent coordination

Agents do not call each other directly. They coordinate through:

1. **The orchestrator**, which owns the task DAG.
2. **The graph**, which is the shared substrate.
3. **Locks on graph subregions** (e.g., a principal's calendar for a
   date range) to prevent two agents from proposing conflicting
   actions.

There is no free-form agent-to-agent chat. That is a load-bearing
design choice: it makes traces linear, makes replay possible, and
makes it obvious when an agent is over-reaching its domain.

## Versioning and rollout

- Every agent is a semver'd artifact.
- New versions are deployed behind a household-scoped flag. A household
  can be pinned to a version for regulatory, sensitivity, or QA
  reasons.
- Prompt changes (for LLM-backed agents) are treated as version
  changes — no silent prompt edits in production.
- Every task record stores the agent version and, for LLM-backed
  agents, the model id and prompt hash. Replay reconstructs the same
  inputs.

## What agents are *not* allowed to do

- Modify policy. Ever. Policy changes require a human path.
- Write `confirmed` facts to the graph without going through the
  learning promotion rules (see [`22-knowledge-graph.md`](./22-knowledge-graph.md)).
- Call other agents directly.
- Send anything to the customer or to a third party without the
  policy engine's clearance.
- Store per-household state outside the graph.
- Decide their own autonomy level.
