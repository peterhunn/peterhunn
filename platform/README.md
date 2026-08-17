# ATELIER Platform

Codename `ATELIER` — the working software for the Life Management service.
Product and architecture spec lives in `../life-management/`.

## Repository shape

```
platform/
├── packages/
│   ├── domain/     # Life Graph types, provenance, ontology, identity (no framework)
│   └── db/         # Drizzle schema, migrations, repositories
├── apps/
│   ├── api/        # Fastify HTTP service (auth + audit + graph)
│   └── console/    # Next.js manager console
└── scripts/
    └── seed.ts     # Mint a dev manager, household, and bearer token
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
- Fastify API and a Next.js manager console: dashboard of households,
  household detail with graph browse + audit trail.

## What is deliberately not yet built

- Policy engine (see `../life-management/permissions.md`).
- Agents (calendar, inbox, travel, etc.).
- Real auth (passkeys, SSO).
- Router + model registry (see `../life-management/models.md`).
- Any provider integrations.
