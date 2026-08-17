# ATELIER Platform

Codename `ATELIER` — the working software for the Life Management service.
Product and architecture spec lives in `../life-management/`.

## Repository shape

```
platform/
├── packages/
│   ├── domain/     # Life Graph types, provenance, ontology (no framework)
│   └── db/         # Drizzle schema, migrations, repositories
└── apps/
    └── api/        # Fastify HTTP service
```

Console (Next.js) will land in `apps/console` next.

## Prerequisites

- Node.js 20.11+
- pnpm 9+

## Setup

```
pnpm install
pnpm --filter @atelier/db migrate:generate    # emit SQL from schema
pnpm --filter @atelier/db migrate:apply       # create local sqlite file
pnpm dev                                      # run api on :3001
```

The API's default storage is a local SQLite file at
`packages/db/data/atelier.db`. This is a Phase 0 choice; the schema is
portable to Postgres.

## Running tests

```
pnpm test
pnpm typecheck
```

## Design references

- Ontology and invariants: `../life-management/knowledge-graph.md`
- API-facing agent contract: `../life-management/agents.md`
- Policy engine (not yet implemented): `../life-management/permissions.md`
- Storage commitments: `../life-management/data-model.md`

## What is here today

- Household + graph node/edge schema, versioned with provenance and
  confidence per the ontology.
- Action ledger and audit event tables.
- HTTP endpoints for household create/list and graph node create/list.
- No auth, no policy engine, no agents. Those follow the spec's phased
  build order.
