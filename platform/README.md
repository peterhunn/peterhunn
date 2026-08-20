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
│   ├── agents/    # Orchestrator, agent + tool contracts, household + calendar + inbox + research + admin + family + travel agents
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

## Deploy

The API deploys to [fly.io](https://fly.io) via
`apps/api/Dockerfile` + `fly.toml`. First-time setup, secrets,
verification, and update flow live in [`DEPLOY.md`](./DEPLOY.md).

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
  - `travel` — handles `travel.trip.plan` (T3
    `travel.plan.multi`: reads principals + members, travel
    preferences, and identity documents; flags any identity doc
    that expires inside the 6-month post-trip validity window;
    proposes flights + hotels + ground + coordination needs
    across calendar / household / family / inbox) and
    `travel.flight.search` (narrower T2 `travel.match` for a
    single itinerary). The mock planner recognizes "we're going
    to <destination> for <n> weeks in <month>"–style prompts
    and decomposes them into travel + calendar + household +
    family intents, so the "London for two weeks in October"
    bench from models.md runs end-to-end on a fresh clone.
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
- Console: Recent tasks renders per-kind cards — research summary +
  tool trace, admin scan as a table with urgency badges, family
  coverage plan with assignments + open questions, inbox draft
  reply inline, calendar / vendor / school-form projections. Raw
  JSON fallback stays behind a details toggle for anything without
  a bespoke renderer.
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
- Real integrations behind agent tools:
  - Research uses Tavily / Serper / Brave for web search (first
    provider with a key wins) and Jina Reader for URL fetch,
    with graceful mock fallback for every path.
  - Calendar tools (`calendar.create`, `calendar.reschedule`)
    hit Google Calendar when the household has connected a
    `google_calendar` credential; OAuth access tokens are
    refreshed on expiry via the token endpoint and persisted
    back to the credentials store. Fall back to the mock event
    id when no credential is present.
  - Calendar agent's conflict detector merges graph
    `obligation.appointment` nodes with a live Google Calendar
    `events.list` read when the credential is stored — dedupes
    by eventRef so a graph node carrying its Google event id
    doesn't double-count. Falls back to graph-only on read
    failure. Task output flags `liveConsulted` and per-conflict
    `source: "graph" | "google_calendar"`.
  - Message send (`message.send`) hits Gmail when the household
    has connected a `gmail` credential — RFC-822 body assembled
    with `In-Reply-To` + `References` headers when a source
    message id is passed, base64url-encoded, sent via
    `users/me/messages/send`. Shares the OAuth refresh loop
    with Calendar. Falls back to a mock sent-id when no
    credential or on API error.
  - Verification loop for new customer numbers — a manager mints
    a 6-digit code via
    `POST /households/:id/messaging/verifications`, the customer
    texts the code from the number they want to bind, and the
    webhook (`/messaging/inbound/twilio` or `.../mock`) detects
    the code in the body, creates the endpoint, marks the
    verification consumed, and replies "Verified — you're now
    connected to <household name>." Codes live 15 min by
    default (`ttlSeconds`), one-shot, and a code cannot bind an
    address already routed to a different household (anti-
    hijack). Console: "Verify a customer number" section on the
    household page mints codes and shows the pending list.
  - Customer messaging surface — an inbound SMS / WhatsApp
    reaches the platform via `POST /messaging/inbound/twilio`
    (and `POST /messaging/inbound/mock` for local dev). The
    webhook resolves via `contact_endpoints` — first by the
    customer's from-address (shared-line deploy: one DID for
    many households, customers identified by their number) and
    then by the to-address (dedicated-line deploy: one DID per
    household). On a miss it looks for a live verification code
    in the body — see the verification loop item above — and
    silently ignores otherwise. On a hit it records
    the messaging event, and dispatches the message body to the
    orchestrator planner as a customer-origin prompt — so
    "book the plumber for Thursday" texted from the customer's
    phone runs `planAndRun` end-to-end and lands the proposal in
    the approval queue for a manager. Twilio signatures are
    verified when `ATELIER_TWILIO_AUTH_TOKEN` is set. Provider
    message ids dedupe retried webhooks. Console: "Customer
    channels" section on the household page to register phone
    numbers and see recent inbound/outbound traffic.
    Outbound: `POST /households/:id/messaging/send { channel,
    to, body }` sends via Twilio when a `twilio` credential
    (`account_sid`, `auth_token`, `from_number` or
    `messaging_service_sid`) is stored, else falls back to a
    mock send with a visible reason. Console: Reply button on
    each inbound message opens an inline compose that hits the
    send route.
  - Properties & assets management — parallel to people, over
    `place.property` + `asset.vehicle` + `asset.equipment` +
    `asset.membership` + `asset.pet` graph nodes.
    `GET /households/:id/assets` returns a bucketed list;
    `POST` with `{ kind, data }` validates against the
    ontology's Zod schema for that kind and creates a node;
    `PATCH` merges + supersedes; `DELETE` retires. Console:
    Properties & assets panel on the household page — per-kind
    sections with inline add/edit/remove.
  - First-class people management — `GET /households/:id/people`
    returns `{ principal, member, staff, contact }` bucketed
    from the graph; `POST` accepts
    `{ kind, data }` validated against the ontology's Zod
    schema for that kind; `PATCH` merges + supersedes (history
    preserved, old node retires); `DELETE` supersedes without a
    replacement. Console: People panel on the household page —
    per-kind sections with inline add/edit/remove. Nothing
    bypasses the graph — every person is a `person.*` node with
    provenance stamped `manager_observed`.
  - Playbooks — packaged autonomy templates. Each one bundles
    a schedule (weekly, monthly, or interval), a domain, and an
    intent shape; enabling one for a household starts a
    recurring task that lands proposed actions in the approval
    queue. Ships with three first-class templates:
    `admin.weekly-renewals-review` (Monday scan of expiring
    documents), `travel.prep-sweep` (Sunday scan of upcoming
    trips), `family.coverage-check` (monthly coverage plan).
    A playbook runner ticks alongside the sync scheduler,
    respects the per-household autopilot toggle and freeze
    state, and never builds a backlog on a paused household —
    skipped-but-advanced. API:
    `GET/PUT/DELETE /households/:id/playbooks/:playbookId`,
    plus `POST .../run` for "fire it now." Console: Playbooks
    panel on the household page. Global kill switch:
    `ATELIER_PLAYBOOKS_ENABLED=0`. The seed script enables
    the weekly renewals review by default so a fresh clone has
    something proactive scheduled from tick zero.
  - Proactive autopilot — after each sync tick, freshly-inserted
    inbox messages are auto-dispatched to the inbox agent
    (triage → extract obligations → draft reply → propose
    `message.send`), and fresh calendar events are auto-checked
    for conflict against the household's tracked obligations
    (`calendar.event.observe` intent). Because `message.send` is
    draft-authority, the drafted reply lands in the approval
    queue for a manager to review — no manager click required to
    get the work started. Per-household toggle
    (`households.autopilotEnabled`, default on) via
    `POST /households/:id/autopilot`; global kill switch via
    `ATELIER_AUTOPILOT_ENABLED=0`. A frozen household is skipped
    silently regardless. Console: on/off switch on the household
    header.
  - Background sync scheduler — the API boots a scheduler that
    walks every household on an interval
    (`ATELIER_SYNC_INTERVAL_SECONDS`, default 300s) and runs the
    incremental sync for every connected provider: Gmail via
    History API into `inbox_messages`, Google Calendar via
    `events.list` syncToken into the new `calendar_events`
    mirror. Overlapping ticks are prevented; a failure on one
    household or one provider never stops the loop for the
    others. Disable with `ATELIER_SYNC_ENABLED=0` (tests and
    one-shot workers). Cursor state is observable at
    `GET /households/:id/sync-state` — one row per provider with
    the last cursor and result summary. On-demand endpoints:
    `POST /households/:id/inbox/sync` and
    `POST /households/:id/calendar/sync`, plus
    `GET /households/:id/calendar/events` for the mirrored
    schedule.
  - Google Calendar incremental sync — first call for a
    household does a bounded full pull (past 30d + next 365d,
    configurable per request) and stores the returned
    `nextSyncToken`. Subsequent calls stream only changed events
    via the syncToken; cancellations arrive as
    `status: cancelled`. A 410 Gone response (token invalidated
    after ~30d) auto-clears the cursor and falls back to a full
    pull. Response includes `mode: full | incremental |
    up_to_date | token_reset` so the console can surface which
    path ran.
  - Gmail inbound sync — `POST /households/:id/inbox/sync`
    pulls unread INBOX messages via `users/me/messages` +
    `messages/{id}?format=full`, walks MIME parts for text
    (falls back to HTML-stripped), parses From/Subject/Date,
    and dedupes on `(external_provider, external_message_id)`
    into the `inbox_messages` table. First call is a full
    pull; subsequent calls use Gmail's History API against a
    per-household cursor stored in the new `sync_state` table
    so only deltas travel. History 404 (cursor >~7d old) auto-
    resets to a full pull. Response includes `mode: full |
    incremental | up_to_date | cursor_reset` so the console
    surfaces which path ran. Console: Sync Gmail button in the
    inbox section header (dimmed until Gmail is connected).
- Credentials store — a first-class `credentials` table + repo +
  API for delegated tokens (OAuth, API keys) the platform holds
  on the customer's behalf. List endpoint returns metadata only;
  the raw blob never leaves the server. Tools access credentials
  through `ToolContext.readCredential(provider)`.
- Google OAuth consent flow — one-click "Connect Google" on
  the household page requests Calendar + Gmail scopes in a
  single consent, exchanges the code for tokens on callback,
  hits userinfo for from_address/from_name, and stores two
  credential entries (google_calendar + gmail) automatically.
  Signed HMAC state carries the household id + returnTo through
  the redirect; state has a 15-minute TTL. Manager posts
  through server action → API issues authUrl → browser bounces
  to Google → API callback stores credentials → browser lands
  back on the household page with a ?oauth=ok banner.
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
