# HTTP API reference

Every endpoint the Fastify API in `apps/api` exposes today.
Grouped by area, in the same order the routes are registered in
`apps/api/src/server.ts`. Auth-scoped routes require a bearer
token minted by `identityRepo.mintToken` (see
`docs/41-authentication.md`); the middleware in
`apps/api/src/auth.ts` resolves the actor and, for any path
beginning with `/households/:householdId/`, verifies the caller
has a live grant on that household and stashes it in
`req.householdContext`. `sensitive: true` on a route's audit
config marks the operation as one that reads or mutates
customer-facing state — every call gets an
`audit_events` row via the plugin in `apps/api/src/audit.ts`.

Everything except `/healthz`, the OAuth callback, and the two
public webhook paths under `/messaging/inbound/*` requires a
bearer token. Public webhooks carry their own signature check
(Twilio) or nonce check (OAuth state).

The Next.js console consumes these through `api(token)` in
`apps/console/src/lib/api.ts` — that file is the ground-truth
typed client. Anything below is the API's own shape.

---

## Health

- `GET  /healthz` — liveness probe. No auth. Returns
  `{ ok: true, service: "atelier-api" }`.

## OAuth (Google — Gmail + Calendar)

- `GET  /` — no-op landing so a bare API URL doesn't 404 in the
  browser tab an OAuth flow leaves behind.
- `GET  /oauth/google/config` — public config sanity read:
  `{ configured, clientId, clientSecret, stateSecret, redirectUri, scopes }`
  (booleans indicate whether each env var is set; no secret
  values). Used by the console to render "OAuth not configured".
- `POST /households/:householdId/oauth/google/start` —
  body `{ returnTo }`. Manager-authorised; mints a state nonce
  and returns `{ authUrl }` to redirect the browser to.
- `GET  /oauth/google/callback` — Google's redirect target.
  `?code=&state=` completes the exchange; on success renders an
  HTML "you can close this tab" page and closes the popup.

## Identity — `/me`

- `GET  /me` — resolved actor: `{ actor: { type, id,
  displayName, householdIds } }`.
- `GET  /me/tokens` — tokens the current actor owns (metadata
  only — no secrets).
- `POST /me/tokens/rotate` — body `{ ttlSeconds? }`. Revokes
  the current token, mints a new one, returns
  `{ token, expiresAt }`.
- `POST /me/tokens/:tokenId/revoke` — 204 on success.
- `GET  /me/attention` — cross-household attention feed for a
  manager: `{ generatedAt, items[], counts: { deliveryFailures,
  unreadThreads, upcomingObligations, frozenHouseholds,
  staleApprovals } }`. Item kinds: `delivery_failure`,
  `frozen_household`, `stale_approval`, `unread_thread`,
  `upcoming_obligation` — ranked in that order. See
  `apps/api/src/routes/me.ts` for the aggregation rules.

## WebAuthn (passkeys)

- `POST /webauthn/register/options` — challenge for a new passkey.
- `POST /webauthn/register/verify` — verify attestation and
  persist the credential.
- `POST /webauthn/login/options` — challenge for assertion.
- `POST /webauthn/login/verify` — verify assertion, mint a session
  token.
- `GET  /me/passkeys` — list this actor's registered passkeys
  (metadata only).
- `DELETE /me/passkeys/:passkeyId` — revoke a passkey.

## Households

- `GET  /households` — households the caller has grants on
  (manager) or every household (system actor).
- `GET  /households/:householdId` — 404 if unknown.
- `POST /households` — `{ name, tier, riskTier? }` — 201 with
  the created row. Manager/system only.
- `GET  /households/:householdId/snapshot` — single-shot health
  rollup: audit chain valid state, approvals/messaging counts,
  weekly action mix, top action classes, top authority policies,
  upcoming obligations. See `docs/31-manager-console.md`
  §"Household health snapshot".
- `POST /households/:householdId/autopilot` — `{ enabled }` —
  toggles the autopilot pipeline for this household.
- `POST /households/:householdId/instant-ack` — `{ enabled }`.
  See `docs/32-customer-messaging.md` for what the ack does.
- `POST /households/:householdId/agent-sending` — `{ enabled }`.
  Wire-level gate on agent-authored sends (customer-facing
  messaging). Default off.

## Graph (nodes + edges + category views)

- `GET  /households/:householdId/nodes` — every non-superseded
  node.
- `POST /households/:householdId/nodes` — create a node
  (validated against the type-specific Zod schema in
  `packages/domain/src/entities.ts`).
- `GET  /households/:householdId/edges` — every edge.
- `POST /households/:householdId/edges` — create an edge.
- `GET  /households/:householdId/graph/by-category` —
  `?type=…` optional filter. Category-sorted view.
- `GET  /households/:householdId/graph/by-category/:category` —
  narrow to one category.
- `GET  /households/:householdId/people` — participants
  (principal/member/staff/contact).
- `POST /households/:householdId/people`
- `PATCH /households/:householdId/people/:nodeId`
- `DELETE /households/:householdId/people/:nodeId`
- `GET  /households/:householdId/assets` — property/vehicle/
  equipment/membership/pet.
- `POST /households/:householdId/assets`
- `PATCH /households/:householdId/assets/:nodeId`
- `DELETE /households/:householdId/assets/:nodeId`
- `GET  /households/:householdId/documents` —
  document.identity/legal/policy/record/receipt.
- `POST /households/:householdId/documents`
- `PATCH /households/:householdId/documents/:nodeId`
- `DELETE /households/:householdId/documents/:nodeId`

## Document files (blob storage)

- `PUT  /households/:householdId/documents/:nodeId/file` — upload
  a binary. Content-Type must be one of image/*, application/pdf,
  application/octet-stream, or text/plain (see
  `apps/api/src/server.ts` for the parsers). Body limit
  `ATELIER_MAX_UPLOAD_BYTES` (default 25 MiB). Stores in the
  local blob store keyed by sha256 shard prefix.
- `GET  /households/:householdId/documents/:nodeId/file` — stream
  the blob back.
- `POST /households/:householdId/documents/:nodeId/extraction/resolve` —
  accept a subset of extracted fields, optionally with edits.
- `GET  /households/:householdId/documents/:nodeId/audit` —
  document-scoped audit events + lineage.

## Audit + Merkle chain

- `GET  /households/:householdId/audit` — recent audit_events
  rows. Sensitive.
- `GET  /households/:householdId/audit/chain/head` — current head
  of the household Merkle chain.
- `GET  /households/:householdId/audit/chain/verify` — walk the
  household chain end-to-end. Returns
  `{ result: { valid, eventCount, headHash, brokenAtEventId? } }`.
- `GET  /households/:householdId/audit/chain/person/:principalId/head` —
  head of a per-person sub-chain.
- `GET  /households/:householdId/audit/chain/person/:principalId/verify` —
  walk one person's chain.

See `docs/52-observability.md` §"Audit chain (Merkle DAG)" for
the canonicalisation and hash contract.

## Policies + suggestions + actions

Policies are authority data. Actions are the ledger of what
happened.

- `GET  /households/:householdId/policies` — active policies.
- `POST /households/:householdId/policies` — `{ spec }` (see the
  `PolicySpec` Zod in `packages/domain/src/policy.ts`).
- `DELETE /households/:householdId/policies/:policyId` — revoke.
- `POST /households/:householdId/policies/evaluate` — dry-run
  the engine against an `ActionRequest`; returns the decision
  the engine would take.
- `GET  /households/:householdId/policies/:policyId/lineage` —
  policy details + (when adopted from a suggestion) the basis
  policy and hydrated basis approvals. Doubles as the target
  of the Recent-actions Authority drill-in. See
  `docs/33-permissions-and-autonomy.md` §"Adopted-policy lineage".
- `GET  /households/:householdId/policies/suggestions` —
  autonomy-ladder promotion + demotion suggestions.
  `?threshold=&windowDays=` optional overrides.
- `POST /households/:householdId/policies/suggestions/adopt` —
  `{ actionClass, subjectPrincipalId, kind? }`. Creates the
  new policy; on `kind: "demote"` also revokes the misconfigured
  execute policy.
- `POST /households/:householdId/policies/suggestions/dismiss` —
  hide a promotion suggestion until the streak breaks (a
  rejection/edit clears the dismissal automatically).
- `GET  /households/:householdId/actions` — recorded actions ledger.
- `POST /households/:householdId/actions` — manual `action`
  record. Used by tests and out-of-band flows.
- `POST /households/:householdId/freeze` — `{ reason }`.
  Household enters observe mode across every domain.
- `POST /households/:householdId/unfreeze` — 204.

## Orchestrator

- `POST /households/:householdId/orchestrator/run` — dispatch a
  single intent through the planner + tools.
- `POST /households/:householdId/orchestrator/plan-and-run` —
  `{ prompt, origin? }`. Planner produces intents from a free-form
  prompt; each runs in turn.
- `GET  /households/:householdId/orchestrator/runs` — recent
  orchestrator runs.
- `GET  /households/:householdId/tasks` — recent tasks.

## Approvals

- `GET  /households/:householdId/approvals` — every approval for
  this household.
- `POST /households/:householdId/approvals/:approvalId/approve` —
  `{ note? }`. Resolves the approval, records the resulting
  action, updates the escalated task.
- `POST /households/:householdId/approvals/:approvalId/reject` —
  `{ note }`.
- `GET  /approvals/inbox` — cross-household pending approvals
  for the calling manager.

Pending approvals with a `deadlineAt` are swept to `expired` by
the scheduler (`apps/api/src/approval-expiry.ts`); the
`stale_approval` attention kind surfaces them ahead of time.
See `docs/33-permissions-and-autonomy.md` §"Expiration sweeper".

## Models + observability

- `GET  /models` — model registry.
- `GET  /models/task-classes` — task-class registry.
- `GET  /models/select` — dry-run router selection.
- `GET  /households/:householdId/model-calls` — recent model
  calls (raw ledger).
- `GET  /households/:householdId/model-calls/daily` —
  `?windowDays=N` (default 30). Per-day rollup by tier.
- `GET  /households/:householdId/inference-budget` — remaining
  budget for the current window.
- `GET  /households/:householdId/runs/:runId` — run detail with
  timeline (tasks + model calls + actions).
- `GET  /households/:householdId/tasks/:taskId/model-calls` —
  every model call under one task.

## Inbox (Gmail)

- `GET  /households/:householdId/inbox` — inbox_messages rows.
- `GET  /households/:householdId/inbox/:messageId` — single row.
- `POST /households/:householdId/inbox` — enqueue a synthetic
  inbox message (tests + manual triage).
- `POST /households/:householdId/inbox/sync` — trigger a Gmail
  sync now (background scheduler runs it periodically).

## Credentials (OAuth tokens + provider secrets)

- `GET  /households/:householdId/credentials`
- `POST /households/:householdId/credentials` — attach a
  credential.
- `POST /households/:householdId/credentials/:credentialId/revoke`
- `GET  /households/:householdId/sync-state` — cursor state for
  every provider we sync.

## Calendar (Google Calendar)

- `GET  /households/:householdId/calendar/events` — synced
  events. `?from=&to=` querystring filter.
- `POST /households/:householdId/calendar/sync` — force-run
  the sync now.

## Messaging (SMS/WhatsApp/iMessage + email out)

Public webhooks — no bearer:

- `POST /messaging/inbound/twilio` — Twilio webhook. Parses
  form-encoded body, resolves the household by destination
  number, records the event, optionally fires the instant ack,
  hands off to the planner. Returns TwiML.
- `POST /messaging/inbound/mock` — same shape as twilio but
  JSON body; for local dev + tests.
- `POST /messaging/status/twilio` — delivery status callback.
- `GET  /messaging/config` — concierge line address + shared-
  line active flag.

Household-scoped:

- `GET  /households/:householdId/messaging/endpoints` — contact
  endpoints (phone/email + consent state).
- `POST /households/:householdId/messaging/endpoints` — add one.
- `DELETE /households/:householdId/messaging/endpoints/:endpointId`
- `GET  /households/:householdId/messaging/events` — inbound +
  outbound events.
- `POST /households/:householdId/messaging/send` —
  `{ channel, to, body }`. Manager-typed only unless
  agent-sending flag is on (see `docs/32-customer-messaging.md`).
- `POST /households/:householdId/messaging/send-email` — Gmail
  send (with In-Reply-To + References threading).
- `POST /households/:householdId/messaging/invite` — issue an
  invite code to a customer for endpoint binding.
- `POST /households/:householdId/messaging/verifications` —
  create a verification code for an existing endpoint.
- `GET  /households/:householdId/messaging/verifications`
- `GET  /households/:householdId/messaging/sessions` — active
  conversation sessions.

## Customer activity (unified timeline)

- `GET  /households/:householdId/customers/:principalId/activity` —
  merged SMS/WhatsApp/iMessage/email timeline for one principal,
  grouped by conversation. See
  `docs/32-customer-messaging.md` §"Unified customer activity".

## Playbooks

- `GET  /households/:householdId/playbooks` — catalog annotated
  with this household's enablement state.
- `PUT  /households/:householdId/playbooks/:playbookId` —
  `{ config? }`. Enable-or-update; config merges over the
  playbook's defaultConfig.
- `DELETE /households/:householdId/playbooks/:playbookId` —
  disable (row stays, `enabled = "no"`).
- `POST /households/:householdId/playbooks/:playbookId/run` —
  fire once now, out of schedule.
- `GET  /households/:householdId/playbooks/suggestions` —
  shipped playbooks whose signal check matches this household.
  See `docs/33-permissions-and-autonomy.md` §"Playbook
  suggestions".

---

## Auth model

Every non-public route reads the bearer token via
`Authorization: Bearer <token>`, resolves the actor
(`manager` | `principal` | `system` | `agent`), and — for
`/households/:householdId/…` paths — verifies the actor has a
grant on that household id. The verified `HouseholdId` is stashed
on `req.householdContext` so handlers use it verbatim instead of
re-reading the URL param, keeping the auth contract in one place.

Rate limiting keys on `Bearer <token>` when present, on IP
otherwise (see `apps/api/src/server.ts`). Health is exempt.

## Audit posture

Every mutating route (and most reads) carries a `config.audit`
block:

```ts
{ action: "policy.create", resourceType: "policy", sensitive: true }
```

The `auditPlugin` writes a row to `audit_events` after the
handler runs — which in turn triggers the Merkle DAG append in
`auditChainRepo.append`, so the chain covers not just customer-
facing state changes but every reflex the API takes.
