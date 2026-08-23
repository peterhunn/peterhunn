# Observability

What the platform records about itself, where you look for it,
and how to answer the four questions that come up in real
operation: what happened, what did it cost, why did the agent
decide that, and can I prove it later.

Adjacent reading: [`23-data-model.md`](./23-data-model.md) for
the tables involved, [`40-security.md`](./40-security.md) for
the audit-export posture.

## Four ledgers

Every side-effectful thing the platform does lands in one of
four durable ledgers. All of them are queried through the
console; all of them survive a process restart.

### 1. `audit_events` — who touched what

One row per successful household-scoped HTTP request.
Automatically written by the `auditPlugin` `onResponse` hook.

- `actorType`, `actorId` — who initiated (manager, agent,
  system, customer).
- `action` — from the route's config, e.g. `messaging.invite`,
  `webauthn.register.verify`.
- `resourceType`, `resourceId` — best-effort attribution
  (household, node, action, credential).
- `sensitive` — a boolean the route can set to flag entries
  that operators should look at first.
- `metadata` — a JSON blob with method, url, response status.

Used for: **who did what.** "Which manager touched Ada's
graph in the last 24h?" is a straight query against this
table.

### 2. `actions` — every tool invocation

One row per tool-execute attempt, whether it succeeded or not.

- `agent`, `agentVersion`, `tool`, `toolVersion` — provenance
  chain.
- `actionClass`, `sideEffectClass` — from the tool
  registration.
- `policyIdAuthorizing` — which policy row authorised the
  autonomy rung that ran this.
- `outcome` — `planned` | `succeeded` | `failed` | `refused`
  | `rolled_back` | `awaiting_approval`.
- `amountUsd` — for financial actions; feeds the rolling
  spend rollups the policy engine consults.
- `inputsHash`, `outputsHash` — sha256 of the tool inputs
  and outputs. Replay-safe; PII stays out of the ledger.

Used for: **what did the system actually DO externally.** Every
booking, every send, every purchase.

### 3. `model_calls` — every LLM call

One row per invocation of `callModel` / `callModelWithTools`.

- `taskClass`, `minTier`, `selectedTier` — router provenance.
- `modelId`, `provider` — which specific model served this
  call.
- `inputTokens`, `outputTokens`, `cachedInputTokens`,
  `cacheWriteInputTokens`, `costUsdEstimated` — usage metrics.
- `latencyMs`, `finishReason` — reliability.
- `routerReasons` — the array of `["hnw_risk_tier_pins_T3",
  "budget_over_relaxed_to_declared_min", ...]` that explains
  the tier decision.
- `inputHash`, `outputHash` — sha256 for replay.
- `triggeringRunId`, `triggeringTaskId` — links to the
  orchestrator run that made the call.

Used for: **what did it cost, why did the router pick that
model, is anything running away.**

### 4. `orchestrator_runs` + `tasks` — the plan history

One `orchestrator_runs` row per top-level `planAndRun` (a
customer text, a manager-triggered intent, a scheduled
playbook fire). Each run has 1..N `tasks` — the planner task
itself, then one per agent-execution task.

- `intentKind`, `intentAttrs` — what triggered the run.
- `origin`, `originBy` — the trigger source (`customer`,
  `manager`, `system`, `proactive`).
- `state` — `running` | `completed` | `failed` | `partial`.
- Tasks link back to `agent`, `kind`, `state`,
  `decisionSummary`, `outputs`, `errorMessage`.

Used for: **why did the agent decide that.** Every run
timeline in the console reads from this pair.

## Console surface

Three views wire the ledgers into an operator UI:

### Cost dashboard (`GET /households/:id/model-calls/daily`)

Per-household daily rollup of `model_calls`. Bars by tier
(T1 / T2 / T3), totals in USD, latency percentiles. Right
sidebar shows the current 30-day rollup vs. the household's
cap. Status badges: `under` (green), `approaching` (amber, ≥
80% of cap), `over` (red, ≥ 100%), `over_hard` (red-hard, ≥
`ATELIER_BUDGET_HARD_MULTIPLE`).

Refresh cadence: on demand. Backing repo query is cheap
(`GROUP BY day, tier`) and doesn't need caching.

### Run timeline (`GET /households/:id/runs/:runId`)

One page per orchestrator run:

- Header: intent, origin, state, wall-clock duration, total
  cost.
- Tasks list: every task with its state, decision summary,
  and any error.
- Interleaved model calls and actions on a single time axis
  so you can see "planner call at T+0 → task 1 model call at
  T+2s → task 1 tool at T+4s → …" without switching tabs.

### Approval queue (`GET /me/approvals`)

The manager-facing queue of any action that policy pushed
through the approval flow. Each entry shows proposal, agent,
tool, inputs, and the policy trace ("why did this need
approval?"). Approving replays the saved inputs with the
approver stamped in `actions`.

## Budget enforcement

The router consults the budget rollup on every call. Three
tiers of enforcement:

| Ratio               | Status         | Behaviour                                                                             |
| ------------------- | -------------- | ------------------------------------------------------------------------------------- |
| < 0.8               | `under`        | Nothing changes. Router picks by task class + risk tier.                              |
| ≥ 0.8               | `approaching`  | Same as `under`; the console badges "approaching budget".                             |
| ≥ 1.0               | `over`         | Router demotes to declared min tier for each task class. Console badges "over budget". |
| ≥ 1.5 (tunable)     | `over_hard`    | `callModel` throws `BudgetExceededError` BEFORE selection.                            |

Hard-cap refusal fires **before** the router runs, so a
runaway agent can't drain the account past the hard line. The
multiplier is `ATELIER_BUDGET_HARD_MULTIPLE` (default 1.5,
must be ≥ 1). System-scope calls with no `householdId`
attribution still run when `over_hard` (extractor cron, health
checks — nothing to attribute).

Cleared by (a) waiting for the 30-day rollup window to slide,
(b) raising the tier cap for that household, or (c) a
one-off temporary bump via env. The "manager approves a
specific overrun in the UI" flow is not built yet.

## Audit export

`audit_events` streams out of the app database on its own
timer (default 60s). Pluggable sink; cursor lives in
`audit_export_state` per sink; the exporter advances the
cursor only after the sink resolves. A sink outage stalls the
export but never drops an event — the next tick retries the
same window.

Sinks:

- **file** (default) — writes each batch as one `.ndjson`
  under `<dir>/<yyyy>/<mm>/<dd>/`, fsync-before-close. Pair
  with an out-of-band mover (rclone / `aws s3 sync` / a Fly
  volume snapshot) that lands the shards in WORM storage.
- **s3** — direct `PutObject` under
  `<prefix>/<yyyy>/<mm>/<dd>/<batchId>.ndjson` with
  `ServerSideEncryption: AES256`. AWS credentials come from
  the standard SDK chain (env → IAM role → `~/.aws/config`).
  Point at a bucket with Object Lock in COMPLIANCE mode for
  the compliance posture.
- **webhook** — declared but not implemented. Selecting it
  logs "not implemented — DISABLED" and no-ops.

Env: see [`51-environment.md`](./51-environment.md#audit-export).

## Provider fallback safety

Every real integration (Google, Twilio, Anthropic, web
search, blob store) has a mock fallback for missing
credentials or errors. Fallbacks stamp `provider: "mock"` and
a `reason` on the response. The reason surfaces through the
console so an operator sees "using mock — no_twilio_credential"
rather than "sent OK." **No silent degradation** is a
load-bearing invariant — see
[`20-architecture.md §9`](./20-architecture.md).

## Metrics we deliberately DON'T have

- **APM / distributed tracing.** Fastify's request log is
  sufficient for phase 0. Real APM (OpenTelemetry into
  Honeycomb / Datadog) is the follow-up when we outgrow the
  log stream.
- **User-facing analytics.** The customer never sees a
  dashboard. Nothing collects "how often does Ada text."
- **A/B testing scaffold.** Every household is bespoke enough
  that A/B on a small n isn't meaningful yet.

## Reference: querying by hand

Local SQLite. Every table above is queryable directly for
one-off ops:

```
sqlite3 packages/db/data/atelier.db
> .headers on
> .mode column
> SELECT actor_type, action, count(*)
   FROM audit_events
   WHERE household_id = 'hh_...' AND at >= '2026-08-01'
   GROUP BY actor_type, action
   ORDER BY 3 DESC;
```

In prod (Postgres, when we get there) same shape — the
repositories are dialect-agnostic on purpose.
