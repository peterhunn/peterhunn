# ATELIER Platform

Codename `ATELIER` — the working software for the Life Management service.
Product and architecture spec lives in `../life-management/`.

## Repository shape

```
platform/
├── packages/
│   ├── domain/     # Life Graph types, provenance, ontology, identity, policy, models (no framework)
│   ├── db/         # Drizzle schema, migrations, repositories
│   ├── policy/     # Autonomy-rung evaluator, scope matcher, rolling limits
│   ├── agents/    # Orchestrator, agent + tool contracts, household + calendar + inbox + research + admin + family agents
│   └── router/     # Model registry, tier-aware router, callModel + mock provider
├── apps/
│   ├── api/        # Fastify HTTP service (auth + audit + graph + policy + actions + orchestrator + models)
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
  ledger. Two specialist agents:
  - `household` — handles `household.vendor.schedule` and
    `household.vendor.purchase` via mocked `vendor.schedule` and
    `vendor.purchase` tools.
  - `calendar` — handles `calendar.appointment.create` and
    `calendar.appointment.reschedule` via mocked `calendar.create` and
    `calendar.reschedule` tools. Runs conflict detection over
    `obligation.appointment` nodes and writes results back to the graph
    on success (superseding the old node on reschedule). Cross-day
    reschedules trip the seeded escalation and land in the approval
    queue as an Ask.
  - `inbox` — handles `inbox.message.process`. Triages via T1
    (`inbox.triage`), extracts obligations via T1 (`inbox.extract`)
    and writes each to the graph as `obligation.deadline` candidates
    with sourceRef pointing to the message, drafts a reply via T2
    (`inbox.draft.reply.low`) or T3 (`inbox.draft.reply.sensitive`)
    depending on the triaged recipient class, then proposes
    `message.send`. The send tool's policy sits at draft, so drafts
    land in the approval queue for a manager to review, edit, and
    send. Storage: dedicated `inbox_messages` table (not the graph —
    the graph stores extracted facts, not message bodies).
  - `research` — handles `research.query`. First agent that drives
    the multi-turn LLM tool-use loop via
    `ctx.callModelWithTools`. Passes two LLM-side tools
    (`search_web`, `fetch_url` — mocked for phase 0), lets the
    model call them iteratively via the router's tool loop, and
    returns a summary with tool trace in the task outputs. Tier
    routes to `research.structured` (T2) when a sources list is
    provided, else `research.open` (T3).
  - `admin` — handles `admin.renewals.review`. Scans the graph
    deterministically for `document.*` nodes with `expiresAt`
    inside a window (default 60 days), runs a single T1
    `admin.renewal.detect` batch classification over the whole
    list (cheap and coherent), and writes one
    `obligation.deadline` candidate per item back to the graph
    with `sourceRef` pointing to the source document.
  - `family` — handles `family.coverage.propose` (draft a
    coverage plan across household members, staff, and trusted
    contacts for a period a principal is unavailable — one T2
    `family.coverage_plan` call, plan lands in task outputs) and
    `family.school.form_due` (deterministic — queues an
    `obligation.deadline` candidate for a school form due for a
    specific member).
- Console: "Run intent" form on the household page.
- Approval queue — non-execute policy decisions (draft, ask) persist
  as `approvals` rows carrying the tool name, inputs, authority policy
  id, proposer, and reasons. Approving replays the tool with the
  saved (or edited) inputs, records the action ledger row with
  approver + channel, and closes the paired task. Rejecting closes
  the task with the note.
- Console: cross-household approval Inbox on the dashboard; per-
  household Awaiting decision cards on the household page; Approve /
  Reject controls with optional edit note.
- Model registry — four tiers (T0 rules / T1 small / T2 mid / T3
  frontier). Router picks a specific model per task class with hard
  rules (execute+hazardous → T3 always; HNW household → T3 pin) and
  fallback chains that only ever escalate up-tier. Mock provider so
  the flow runs without external API calls. Every call lands in the
  `model_calls` ledger with input/output hashes, cost estimate,
  latency, and the router's reasons.
- Per-household inference budget rollup (30-day window) driven by
  subscription tier; router demotes back to the declared min when
  the household is over budget, never silently degrades below it.
  Console: budget bar on the household page (green / amber / red),
  Models page in the top nav listing every registered model and
  task class.
- Live provider adapters — Anthropic (Messages), OpenAI (Chat
  Completions), Google Gemini (generateContent), and a generic
  OpenAI-compatible adapter (Ollama, Together, Groq, vLLM,
  Fireworks, and any other endpoint that speaks
  /v1/chat/completions). Missing API keys fall back to the mock
  adapter and stamp a visible reason on the response so the
  fallback is never silent. Configure via `.env` — see
  `.env.example`.
- Tool use across Anthropic, OpenAI, and OpenAI-compatible
  adapters. `ModelCall.tools` + `toolChoice` are provider-agnostic;
  each adapter translates to native shape (Anthropic tool blocks,
  OpenAI function calling). `callModelWithTools` runs a bounded
  multi-turn loop, dispatching each `tool_call` back to a supplied
  handler until the model returns final text. Every turn is a
  separate ledger row.
- Anthropic prompt caching — `cache: true` on any message stamps
  `cache_control: { type: "ephemeral" }` on the corresponding block
  (and the tail of the tools list). `cache_creation_input_tokens`
  and `cache_read_input_tokens` land in the model_calls ledger as
  first-class columns. The planner's system prompt is marked for
  caching by default, so a real Anthropic key produces immediate
  cost reduction on the second and subsequent planner calls.
- LLM-driven Orchestrator planner — `planAndRun(prompt)` runs an
  `orchestrator.simple` (short single-domain) or
  `orchestrator.cross_domain` (long / multi-domain) model call, parses
  a structured plan `{ reasoning, intents[] }`, and dispatches each
  intent through the same `.run()` path programmatic callers use. The
  planner run and the specialist runs are all correlated in the task
  ledger. Console: a "natural language → plan & run" mode on the Run
  intent form.
