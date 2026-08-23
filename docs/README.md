# ATELIER — Documentation

Single source of truth for the ATELIER Life Management platform:
what it is, why it's built the way it is, and how to operate it.

The numbered prefixes are for reading order — a new engineer or
operator can walk top-to-bottom and land at "ready to ship." Each
document also stands alone if you know what you're looking for.

## Product

- [`00-overview.md`](./00-overview.md) — What ATELIER is. Glossary,
  invariants, phased build order, non-goals.
- [`10-operating-plan.md`](./10-operating-plan.md) — Phased plan
  for the first 25 customers: hiring, SOPs, quality bar,
  milestones.
- [`11-business-model.md`](./11-business-model.md) — Tiers,
  pricing, unit economics, revenue model, defensibility.

## Architecture

- [`20-architecture.md`](./20-architecture.md) — Load-bearing
  invariants (tenancy, provenance, policy authority, approvals,
  audit, credentials, concierge line). The engineering north star.
- [`21-repository.md`](./21-repository.md) — Monorepo tour: what
  lives where, how the packages fit together, how to run it.
- [`22-knowledge-graph.md`](./22-knowledge-graph.md) — The Life
  Graph: entities, relationships, provenance, learning rules.
- [`23-data-model.md`](./23-data-model.md) — Storage tables, id
  shapes, tenancy, retention, portability.
- [`24-model-routing.md`](./24-model-routing.md) — Model tiers,
  the router, self-hosting policy, cost controls.

## Product surface

- [`30-agents.md`](./30-agents.md) — Orchestrator + specialist
  agents (household, calendar, inbox, research, admin, family,
  travel). Task lifecycle, tool contracts.
- [`31-manager-console.md`](./31-manager-console.md) — Manager
  console: queues, exceptions, quality metrics, capacity.
- [`32-customer-messaging.md`](./32-customer-messaging.md) — The
  concierge line: one number for every customer, profile
  linkage, invite flow, TCPA consent, conversation memory.
- [`33-permissions-and-autonomy.md`](./33-permissions-and-autonomy.md) —
  Autonomy ladder, policy DSL, approvals, spend limits, audit.

## Security & operations

- [`40-security.md`](./40-security.md) — Threat model + gap
  tracking. Colour-coded posture per surface.
- [`41-authentication.md`](./41-authentication.md) — Managers
  (bearer tokens, passkeys / WebAuthn). Customers (concierge-line
  identity). Machine-to-machine.
- [`50-deployment.md`](./50-deployment.md) — Fly.io deploy,
  secrets management, migration runbook, credential-key rotation.
- [`51-environment.md`](./51-environment.md) — Every environment
  variable, what it does, and when it's required.
- [`52-observability.md`](./52-observability.md) — Cost dashboard,
  model-call trace, run timeline, audit event export.

## Contributing

- [`60-contributing.md`](./60-contributing.md) — Recipes: adding
  a node type, an agent, a tool, a provider adapter, a route, a
  repo, a schema, a playbook, tests.

## Provenance

These docs mix product-spec content (the aspirational shape of
the system, largely stable) with implementation-current content
(what the code actually does today). Where they disagree, treat
the code as authoritative and file a docs update. The security
posture and the customer-messaging doc are the fastest-moving
pages; check the last commit on each before you rely on them.
