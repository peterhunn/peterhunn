# ATELIER Platform

Codename `ATELIER` — the working software for the Life Management service.
Product and architecture spec lives in `../life-management/`.

## Repository shape

```
platform/
├── packages/
│   ├── domain/     # Life Graph types, provenance, ontology, identity, policy (no framework)
│   ├── db/         # Drizzle schema, migrations, repositories
│   ├── policy/     # Autonomy-rung evaluator, scope matcher, rolling limits
│   └── agents/     # Orchestrator, agent + tool contracts, one concrete agent
├── apps/
│   ├── api/        # Fastify HTTP service (auth + audit + graph + policy + actions + orchestrator)
│   └── console/    # Next.js manager console
└── scripts/
    └── seed.ts     # Mint a dev manager, household, graph nodes, policies, and a bearer token
```

## Prerequisites

- Node.js 20.11+
- pnpm 9+

## Bring it up

```
pnpm install
pnpm --filter @atelier/db migrate:generate           # emit SQL from schema
pnpm --filter @atelier/db migrate:apply              # create local sqlite file
pnpm --filter @atelier/db exec tsx ../../scripts/seed.ts   # mint a token
pnpm --filter @atelier/api dev                       # api on :3001
pnpm --filter @atelier/console dev                   # console on :3000
```

Open `http://localhost:3000`, paste the token the seed script printed, and
you're inside the console.

## Storage

- Local dev uses SQLite at `packages/db/data/atelier.db` — a Phase-0
  choice. The schema is portable to Postgres; the repositories are
  dialect-agnostic in behavior.
- WAL mode + foreign keys are enabled at connection open.

## Auth (Phase 0)

- Bearer tokens minted from `identity.mintToken(...)`, stored as SHA-256
  hashes.
- The Fastify auth plugin resolves tokens to an `Actor` (customer,
  manager, agent, or system) and attaches it to `req.actor`.
- Household path params are checked against the manager's grants — a
  manager with no grant on a household cannot see or touch it.
- Real auth (passkeys for customers, SSO + hardware keys for managers)
  replaces the bearer surface later; the actor + grant model is what
  stays.

## Audit

- The audit plugin emits an `audit_events` row for every successful
  request that touched a household route. Reads and writes both.
- Route configs (`{ config: { audit: { action, resourceType, sensitive } } }`)
  refine the entry per handler.

## Running tests

```
pnpm test
pnpm typecheck
```

The API test suite spins up an in-memory SQLite, applies migrations,
seeds a manager + household + grant + token, and exercises the auth
and audit paths end to end.

## What is here today

- Household + graph node/edge schema, versioned with provenance and
  confidence per the ontology.
- Action ledger and audit event tables.
- Identity: managers, hashed API tokens, manager→household grants.
- Auth guard on every non-public route, with per-household grant
  enforcement.
- Audit trail on every household-scoped request.
- Policy engine — six-rung autonomy ladder, scope matcher, rolling
  window limits (day/week/month, USD and count), explicit-deny-wins,
  escalation conditions, effective windows, and household freeze.
- Action ledger writes with the authorizing policy id, so audit is
  end-to-end.
- Fastify API endpoints for policies, evaluation, actions, and
  freeze/unfreeze.
- Console pages: dashboard of households; household detail with
  policies, recent actions, graph browse, and audit trail, plus a
  visible freeze banner.
- Agent runtime — Orchestrator + typed Agent/Tool contracts + task
  ledger. One concrete `household` agent that resolves a vendor from
  the graph, runs through the policy engine, invokes a
  `vendor.schedule` tool (mocked for phase 0), and records the action.
- Console: an in-page "Run intent" form on the household detail page
  that fires a real orchestrator run and refreshes the tables.

## What is deliberately not yet built

- Additional specialist agents (calendar, inbox, travel, etc.).
- Real provider integrations behind the tools.
- Real auth (passkeys, SSO).
- Router + model registry (see `../life-management/models.md`).
- Approval routing UI — evaluate returns the decision but the console
  does not yet queue Ask items for a customer channel.
