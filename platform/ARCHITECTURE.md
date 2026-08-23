# Architecture

The load-bearing invariants of the ATELIER platform. Change these
carefully; every downstream module assumes them.

## Layering

```
domain      pure types, ontology, provenance, policy model. Zero
            runtime deps beyond zod. Nothing imports up.

policy      pure evaluator over domain types. Depends on domain.

router      LLM provider adapters + tier gating + call ledger
            contract. Depends on domain. Independent of agents.

agents      Orchestrator, agent + tool contracts, first-class
            agents (household, calendar, inbox, research, admin,
            family, travel). Depends on domain + policy + router.

db          Drizzle schema + repositories. Depends on domain
            only. No agent, no policy, no router imports —
            repositories are dialect-agnostic in behavior so a
            future Postgres swap is a client-factory change.

apps/api    Fastify service. Wires all of the above into HTTP
            routes. Owns background scheduler, autopilot,
            playbook runner, blob store, credential store.

apps/console  Next.js manager UI. Talks only to the API. No
              direct DB access.
```

Cycles across these layers are bugs. Don't import agents from db.

## Invariants

### 1. Tenancy — every read and write is household-scoped

- Every path with `:householdId` is guarded by `authPlugin`
  (apps/api/src/auth.ts). A manager without a grant on the
  household gets 403 before the handler runs. `req.householdContext`
  is set only after the grant check passes.
- Every repository method that touches household-owned tables
  takes a `HouseholdId` and filters on it. If you add one that
  doesn't, tenancy is broken.
- The scheduler, autopilot, and playbook runner all iterate
  `households.list()` and pass the id explicitly. No cross-tenant
  data ever crosses a code path.

### 2. Provenance — every fact in the Life Graph carries it

- `packages/domain/src/provenance.ts` defines the required fields:
  source, assertedBy, assertedAt, confidence, status.
- Every `graphRepo.createNode` call must supply provenance. No
  exceptions.
- Provenance sources are a closed enum (`customer_direct`,
  `manager_observed`, `agent_inferred_*`, `integration_pull`,
  `bulk_import`). Add new sources deliberately, never invent
  strings.
- Node status is `candidate | confirmed | retired`. Edits are
  supersede-and-replace, never in-place mutations. History is a
  first-class property.

### 3. Ontology governance — node types are a closed set

- `NODE_TYPE_SPECS` in `packages/domain/src/entities.ts` is the
  registry. Every entry declares its Zod schema and its Accord
  category (participant | asset | concept | event | transaction).
- Adding a node type means adding a Zod schema and registering
  it. The generic surfaces (`/graph/by-category`, the CTO
  exporter) pick it up automatically.
- `isKnownNodeType(t)` gates parse. Unknown types never land.

### 4. Policy authority — every side effect names its policy

- `packages/policy/src/engine.ts` evaluates an `ActionRequest`
  against the household's policy set + rolling limits + freeze
  state + escalation conditions. Returns a `PolicyDecision`.
- The six-rung ladder: `observe → recommend → draft → ask →
  execute → manage_autonomously`. Higher rungs demote when the
  household is over budget, frozen, or the action class is
  hazardous.
- Every recorded action carries `policy_id_authorizing`. Audit
  is end-to-end.
- Tools that produce side effects declare a `sideEffectClass`
  (`read`, `write_reversible`, `write_hard`, `communication`,
  `financial_hazardous`). The evaluator uses this to decide
  authority.

### 5. Approvals — non-execute decisions become first-class rows

- Draft, ask, or below-execute policy decisions enqueue an
  `approval` row carrying the tool name, saved inputs, proposer,
  and reasons. Approving replays the tool with the (possibly
  edited) inputs. Rejecting closes the paired task.
- Auto-approving something means changing the policy, not
  bypassing the queue.

### 6. Model calls — every LLM call is ledgered

- `modelCallRepo.record(...)` is called on every provider call
  with model id, tier, tokens (in/out/cached/cache_write),
  cost estimate, latency, finish reason, and the router's
  reasons for choosing the model.
- Router's `execute+hazardous → T3` rule and `HNW → T3 pin`
  rule are hard, not heuristics. Cheap-tier violations on
  those paths are bugs.

### 7. Tools mediate all side effects

- Anything that touches an external system (send an email,
  book a calendar slot, hit a vendor API, spend money) goes
  through a `Tool` invocation. Tools declare their side-effect
  class, action class, and version. The orchestrator writes an
  `actions` row on every invocation.
- Agents never call `fetch` directly. If you find yourself
  wanting to, that's a signal to define a tool.

### 8. Credentials never leave the server

- The credentials table stores delegated tokens (OAuth, API
  keys) the platform holds on the customer's behalf.
- List endpoints return metadata only (id, provider, kind,
  label, revokedAt). Never the raw blob.
- Tools access credentials through `ToolContext.readCredential`
  and `readGoogleAuth`, both of which live on the server.
- **Phase-0 gap:** credentials are stored plaintext in SQLite.
  See SECURITY.md — this must be fixed before any real customer.

### 9. Never silent — fallbacks stamp a reason

- Every real integration (Google, Twilio, Anthropic, web
  search, blob store) has a mock fallback path for local dev
  and tests without keys.
- Every mock fallback response carries a `reason` field
  (`no_gmail_credential`, `no_anthropic_api_key`,
  `unsupported_mime: <mime>`, `twilio_400`, etc.). Silent
  degradation is a bug.

### 10. Public webhooks are minimal-info by design

- `/messaging/inbound/twilio` returns identical TwiML for
  unrouted numbers as for accepted-but-unactionable ones. An
  outside prober cannot distinguish "not routed" from "routed
  but nothing happened."
- The mock inbound endpoint returns 404 with detail — for dev
  visibility only; not exposed in production.

### 11. One concierge line for every customer

- **Product posture:** one shared phone number for every
  household in a tenant. A customer texts +CONCIERGE from
  their own number; the inbound webhook resolves the customer
  by (channel, from-address) — unique per person — and routes
  to their household. The same webhook code path also handles
  dedicated-line deploys (customer texts a household's own
  number) by falling back to (channel, to-address) resolution.
- **Outbound:** `resolveTwilioSender(householdId)` in
  `apps/api/src/routes/messaging.ts` prefers a per-household
  `twilio` credential when stored, otherwise falls back to
  the platform-level concierge credential from
  `ATELIER_TWILIO_ACCOUNT_SID` / `_AUTH_TOKEN` /
  `_FROM_NUMBER`. Every outbound (agent-initiated sends,
  invite SMS, direct manager sends) goes through the same
  resolver.
- **Onboarding:** `POST /households/:id/messaging/invite`
  mints a 6-digit verification code AND sends "reply CODE to
  +CONCIERGE" from the concierge line in one call. When the
  customer replies, the inbound webhook's verification-claim
  branch binds their from-address to the household and marks
  the code consumed. If the from-address is already bound to
  a different household, the claim is refused — no cross-
  household hijacking.
- **Config surface:** public `GET /messaging/config` returns
  `{ conciergeNumber, sharedLineActive }` so the console
  header can display the number a manager should tell
  customers to text.
- **Number → profile → household.** `contact_endpoints` carries
  an optional `principalId` pointing at a `person.principal`
  / `person.member` / `person.staff` / `person.contact` node
  in the same household. Set at endpoint creation (direct add)
  or at invite time (carried through `pending_verifications`
  and copied onto the endpoint when the code is consumed).
  `dispatchToPlanner` reads the endpoint's `principalId`,
  looks up the node in the graph, and uses its `fullName` +
  node id as the planner actor's `displayName` + `id`. That's
  how the system knows **who** is texting, not just which
  household. Endpoints without a principal fall back to the
  from-address as the actor — same behavior as before.

## Storage shape

- `households` — tenancy root. `autopilotEnabled` gates the
  scheduler's proactive path. `frozenAt` freezes all agent runs.
- `identity` — managers + hashed bearer tokens + household
  grants. Grant is what the auth plugin checks.
- `nodes` + `edges` — the Life Graph. Versioned by
  supersededAt / supersededBy. Never mutate; supersede.
- `actions` — every tool invocation with policy authority and
  outcome. Charge windows read this.
- `audit_events` — one row per successful household-scoped
  request. Reads and writes.
- `policies` — the policy set. Explicit-deny-wins.
- `orchestrator_runs` + `tasks` — agent execution history.
- `approvals` — non-execute decisions awaiting a manager.
- `model_calls` — every LLM call with tier + cost + tokens.
- `credentials` — delegated tokens. Phase-0 plaintext.
- `sync_state` — per-provider incremental sync cursors.
- `contact_endpoints` + `messaging_events` — customer
  channels + inbound/outbound message history.
- `pending_verifications` — 6-digit codes for binding a
  from-address to a household.
- `document_blobs` — content-addressed metadata for uploaded
  files. Bytes live under ATELIER_BLOB_DIR on local disk;
  S3 is the follow-up backend.
- `household_playbooks` — per-household enabled playbooks
  and their next-fire timestamps.
- `calendar_events` — mirror of the household's Google
  Calendar (post-syncToken).
- `inbox_messages` — the household's inbox
  (post-Gmail-sync). Bodies stored here; extracted facts
  land in the graph as nodes with `sourceRef` pointing at
  the message.

## Runtime shape

- API boots at `apps/api/src/index.ts`. Composes:
  - `buildServer(db)` — Fastify app with all routes.
  - `buildScheduler(db, { autopilot, playbookRunner, ... })` —
    ticks every `ATELIER_SYNC_INTERVAL_SECONDS` (default 300).
    Overlapping ticks blocked by an in-flight flag.
  - `buildAutopilot(db, ...)` — after each sync, dispatches
    the matching agent per fresh inbox message / calendar
    event.
  - `buildPlaybookRunner(db, ...)` — fires enabled playbooks
    whose `next_fire_at` has passed.
- SIGTERM handler stops the scheduler, then closes the server.
- Single-machine deploy. The scheduler's in-flight flag is
  in-process; running two nodes would double-fire. Distributed
  lock is a follow-up when we scale out.

## Where phase 0 ends

Read SECURITY.md for the security-shaped gaps. Beyond those:

- **SQLite in prod.** Portable schema; swap the client factory
  in `packages/db/src/client.ts` to `drizzle-orm/postgres-js`
  when traffic warrants. Migrations regenerate as-is.
- **In-process scheduler.** BullMQ / pg-boss on Postgres when
  we go multi-machine.
- **No queue for outbound API calls.** A rate-limited provider
  can burn our budget on retries. Retry + backoff belongs on a
  queue, not in tool code.
- **No structured event export.** Audit is inside the DB;
  external SIEM / analytics needs a change-data-capture path.
