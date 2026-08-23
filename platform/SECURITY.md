# Security

An honest inventory of what the platform's security posture is *today*
and what needs to change before customer #1. Phase-0 code makes
different trade-offs than a production service; this doc makes those
trade-offs legible so nobody assumes we're further along than we are.

## Reporting a vulnerability

Email `security@atelier.example` (placeholder — change before launch).
Include:

- A description of the issue and how you found it.
- A reproduction (URL, request, expected vs actual behavior).
- Your affiliation, if any.

We'll acknowledge within 3 business days and coordinate a fix
window before any public disclosure.

## Current posture — what's real

### Authentication

- Bearer tokens minted from `identity.mintToken(...)`. Token is
  256 bits of `randomBytes`, base64url-encoded, returned to the
  caller once, stored as SHA-256 hash. The plaintext token never
  touches disk.
- `authPlugin` (apps/api/src/auth.ts) resolves the token to an
  `Actor` on every non-public request. Bad tokens 401.
- Manager grants (`householdGrants`) gate every household-scoped
  path. Missing grant = 403 before the handler runs.

**Real, phase-0-acceptable.** Not real enough for a paying
customer — see gaps below.

### Household tenancy

- Every route with `:householdId` verifies the actor's grant.
- Every repository method that touches household-scoped tables
  filters by household id.
- Cross-tenant data cannot cross a code path. Enforced structurally,
  not by convention.

**Real. Load-bearing.** Adding a route that reads a household
without going through `req.householdContext` is a bug.

### Audit trail

- `auditPlugin` writes one `audit_events` row per successful
  household-scoped request. Includes actor, action, resource,
  and sensitive-flag.
- Every tool invocation records an `actions` row with the
  authorizing policy id, outcome, and (when applicable) amount.
- Approvals carry proposer + reasons. Approving replays the
  saved inputs with the approver stamped.

**Real.** Complete enough to reconstruct any action's chain
of custody.

### OAuth state signing

- Google OAuth consent flow signs the state parameter with an
  HMAC-SHA256 keyed on `ATELIER_OAUTH_STATE_SECRET` (>=16 chars,
  runtime-enforced). Payload carries household id + returnTo +
  nonce + issued-at.
- 15-minute TTL on state. Expired or mangled state → error
  redirect, never an accepted callback.

**Real.** Rotating the secret invalidates in-flight consent
redirects (accepted cost).

### Twilio webhook signature verification

- `verifyTwilioInboundSignature` uses the official Twilio SDK's
  `validateRequest` (HMAC-SHA1 over URL + sorted form params
  concatenated). Required as soon as `ATELIER_TWILIO_AUTH_TOKEN`
  is set. Dev-mode bypass logs a warning.
- Unrouted inbound numbers return identical empty TwiML to
  routed-but-unactionable ones. Outside probers can't
  distinguish.

**Real when the token is set.** Never leave the token unset in
production.

### Provider fallback safety

- Every real integration (Google, Twilio, Anthropic, web search,
  blob store) has a mock fallback for missing credentials or
  errors. Fallbacks stamp `provider: "mock"` and a `reason` on
  the response. No silent degradation.

**Real.** Don't ship code that silently degrades.

## Current posture — the gaps

### 🟢 Credentials at rest are encrypted

- Every credential blob is wrapped with AES-256-GCM before it
  hits the credentials table. Ciphertext lives inside a
  versioned envelope
  `{v: 1, cipher: "<iv-b64>:<authTag-b64>:<ct-b64>"}`.
  Master key comes from `ATELIER_CREDENTIAL_KEY` (32 bytes hex).
- `credentialRepo` throws at construction if the key is missing
  or malformed — the API refuses to boot rather than accept
  plaintext writes.
- `credentialRepo.getSecret` transparently decrypts on read;
  `store` and `updateAccessToken` encrypt on write.
- Legacy plaintext rows (from before this landed) are read
  transparently and upgraded whenever `updateAccessToken` runs;
  `credentialRepo.migrateLegacyRows()` does the bulk upgrade
  ahead of that.
- Version prefix (`v: 1`) leaves room for a v2 with per-row
  data keys wrapped by a KMS master key without ambiguity.

**Still open:** the master key lives in the same process's env
as the DB — a compromised host reads both. KMS-wrapped per-row
data keys close that gap. Rotation of the master key is manual
today; see DEPLOY.md.

### 🟢 Bearer tokens have expiry + rotation + explicit revoke

- Every `mintToken` now stamps an `expires_at`. Default TTL is
  90 days; tunable per mint via `ttlSeconds` or an explicit
  `expiresAt`. Passing `expiresAt: null` opts out (used by the
  seed script for a 1-year dev token — never in the API path).
- The auth plugin uses `identity.resolveToken(token)` which
  returns a discriminated union `{ ok, actor?, reason? }`. 401
  responses now distinguish `invalid_token` (unknown) /
  `expired_token` (past `expires_at`) / `revoked_token`
  (`revoked_at` non-null) so a client can react appropriately.
- Rotation: `POST /me/tokens/rotate` revokes the caller's
  current token and mints a fresh one with the same actor +
  label. Body accepts an optional `ttlSeconds` override.
  Response returns the plaintext token once — never again.
- Explicit revoke: `POST /me/tokens/:tokenId/revoke` marks a
  specific token revoked. A caller may only revoke tokens they
  own (checked against `listTokens` on the actor).
- List: `GET /me/tokens` returns metadata for all tokens owned
  by the actor (id, label, created, expires, lastUsed,
  revoked). Never leaks the hash or plaintext.
- Every successful `resolveToken` stamps `last_used_at` so
  "haven't touched this token in 60 days — safe to revoke?"
  becomes an answerable question.

**Still open:** long-term the phase-0 bearer surface gets
replaced by passkeys (`@simplewebauthn/server`) for managers
and phone-verified access for customers. Bearer tokens then
become internal machine-to-machine credentials only.

### 🟢 Rate limiting

- `@fastify/rate-limit` registered at boot. Global default of
  120 req/min per (bearer token OR client IP if no token) —
  tunable via `ATELIER_RATE_LIMIT_MAX` / `_WINDOW`. Key
  generator hashes the token when present so an attacker can't
  duck a per-IP limit by dropping the header.
- Per-route stricter overrides on the public surface:
  `/messaging/inbound/mock` and `/messaging/inbound/twilio` are
  60/min per IP; `/oauth/google/callback` is 20/min per IP;
  `/oauth/google/config` is 30/min per IP.
- Health endpoint (`/healthz`) is skipped so infra probes
  don't burn the budget.
- 429 response body: `{ error: "rate_limited", message,
  retryAfter }` — the message names the retry window and
  Fastify sets the standard `Retry-After` header.
- `trustProxy: 1` on the Fastify app so per-IP keying reads
  the real client IP from `X-Forwarded-For` behind fly's
  proxy rather than the proxy hop.

**Still open:** limits are in-process only (one bucket per
machine). When we scale to multiple machines, a distributed
store (Redis) is needed so a caller can't get N× throughput
by round-robining. Also: a per-actor "planner burst" limit is
finer-grained than what @fastify/rate-limit does per-route.

### 🟢 Cost caps hard-fail at N× the household cap

- Soft over-budget behavior (demote to declared min tier and keep
  running) is unchanged. That still runs at ratio ≥ 1.0.
- Once spend passes `ATELIER_BUDGET_HARD_MULTIPLE × cap`
  (default 1.5×), `callModel` throws `BudgetExceededError`
  *before* it hits the router or any provider. No fallback, no
  demote, no retry — a runaway agent can't drain the account.
- The refusal surface is `inferenceBudgetFor(...).status ===
  "over_hard"`, which the console budget widget already renders.
  Manager action: raise the tier cap, wait for the 30-day
  rollup to slide, or approve a one-off (currently by env — a
  UI knob is a follow-up).
- The hard-cap check keys on `householdId`. System-scope calls
  with no household attribution still run, which is intentional
  (extractor cron, health checks).

**Still open:** the "approve a one-off overrun" flow is not in
the UI yet — a manager either bumps the multiple in env or
waits. Also: the soft/hard thresholds are global; per-household
overrides land with the pricing model.

### 🟢 SIEM / audit export

- Every `audit_events` row is streamed through a pluggable
  `AuditExportSink` on a periodic tick (default 60s, tunable
  via `ATELIER_AUDIT_EXPORT_INTERVAL_SECONDS`). Cursor lives
  in `audit_export_state` keyed by sink name; the exporter
  advances the cursor only after the sink resolves. A sink
  outage stalls the export but never drops an event — the
  next tick retries the same window.
- **Phase-0 sink: file.** `fileSink({ dir })` writes each
  batch as one `.ndjson` file under `<dir>/<yyyy>/<mm>/<dd>/`
  with fsync-before-close. Paired with an out-of-band job
  (`rclone`, `aws s3 sync`, a Fly volume snapshot) that moves
  those shard directories into WORM storage — the app process
  itself never needs cloud credentials for the compliance
  path.
- **S3 direct sink** and **webhook sink** (real-time push into
  a customer's own SIEM) are declared but not implemented
  yet: `ATELIER_AUDIT_EXPORT_SINK=s3` or `=webhook` logs a
  clear "not implemented — export DISABLED" line rather than
  silently doing nothing.
- Batch objects are named `<iso-timestamp>_<hex>.ndjson`; the
  timestamp is the tick's `nowIso()`, the hex is 4 random
  bytes. Batches are content-addressable-adjacent — a
  reprocessor can order files by name to walk history.
- `exportAuditBatch` is testable in isolation — the
  `AuditExportSink` interface takes `writeBatch(batch)` and
  nothing else. `packages/db/test/audit-export.test.ts` runs
  it end-to-end with a spy sink (cursor advance, dedup on
  re-run, chunking, sink-failure rollback) and with the real
  file sink (round-trip through ndjson on disk).

**Still open:** the S3 and webhook sinks. Wiring
`@aws-sdk/client-s3` behind the S3 sink is one commit; a
customer-configurable webhook sink (HMAC-signed, retries,
DLQ on 4xx) is a second. Neither changes the exporter core
or the cursor model.

### 🟢 Secret scanning on commits

- `.github/workflows/secret-scan.yml` runs `gitleaks-action`
  on every push, PR, weekly schedule, and manual dispatch.
  Uses `.gitleaks.toml` at the repo root with the built-in
  default rules plus ATELIER-specific patterns
  (`atl_<32>` bearer tokens, 64-hex `ATELIER_CREDENTIAL_KEY`).
- Allowlist covers the deterministic test key in
  `vitest.setup.ts` and known-fake fixture strings so real
  hits aren't drowned in noise.
- PR runs comment on the offending commit; branch pushes
  fail the workflow.

**Still open:** GitHub's native secret scanning + push
protection is complementary (catches secrets in commits
that never touch a workflow) and free for public repos.
Enable in repo settings once we're ready.

### 🟢 OAuth state secret supports a rotation window

- `verifyState` tries the current `ATELIER_OAUTH_STATE_SECRET`
  first (hot path), then falls back to
  `ATELIER_OAUTH_STATE_SECRET_PREVIOUS` if set. `signState`
  always uses the current secret — the previous secret is
  verify-only.
- Rotation flow:
  1. Move current → `ATELIER_OAUTH_STATE_SECRET_PREVIOUS`.
  2. Set fresh → `ATELIER_OAUTH_STATE_SECRET`.
  3. Restart. In-flight consent redirects verify under the
     previous secret; new mints sign under the fresh one.
  4. After the state TTL (15 minutes) passes, unset
     `ATELIER_OAUTH_STATE_SECRET_PREVIOUS`. Verification
     loses the fallback and stays strict.
- Both secrets share the >=16-char length gate. A short or
  unset previous secret disables the fallback, not the primary.

**Still open:** the runbook is manual (bump the env, restart).
Automating it (fly.io secrets rotation on a schedule) closes
the operational gap without changing the code.

### 🟢 Security headers

- `@fastify/helmet` registered globally with API-appropriate
  defaults on every response:
  - `Strict-Transport-Security: max-age=15552000; includeSubDomains`
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`
    (API doesn't serve HTML so the lockdown is total)
  - `Referrer-Policy: no-referrer`
- COEP/COOP relaxed (they can break OAuth popup flows;
  API-only doesn't need them).

### 🟢 CORS allowlist

- `@fastify/cors` registered with an explicit origin allowlist
  from `ATELIER_CORS_ORIGINS` (comma-separated). Falls back to
  `ATELIER_CONSOLE_URL` (or `http://localhost:3000` in dev)
  when unset.
- `credentials: true` means the browser sends cookies;
  @fastify/cors refuses to combine that with a wildcard, so an
  origin must be an exact match — no accidental full-open.
- Server-to-server callers (Twilio webhook, Google OAuth
  callback) are unaffected; CORS gates browsers, not curl.

### 🟢 Documented but accepted phase-0 posture

- **SQLite in production.** Single file, no replication. Fly
  volume snapshots are the backup story. Acceptable until we
  have enough traffic to justify Postgres.
- **Local disk blob store.** Content-addressed sha256. Fine
  for phase-0; S3 with server-side encryption is the follow-up.
- **Single-machine scheduler.** In-process in-flight flag.
  Fine while one machine can handle it; distributed lock is a
  scaling follow-up.
- **No customer-visible surface yet.** Everything is
  manager-facing plus the Twilio inbound webhook. Customer
  portal is a separate build.

## Threat model in one page

**Who can attack:**
- **External unauthenticated attacker.** Can hit public
  endpoints (`/healthz`, `/messaging/inbound/*`, OAuth
  callback). Blocked from every household-scoped path by
  auth. Public webhooks return minimal info by design.
- **Compromised manager account.** Full access to every
  household they have a grant on. Cannot see other
  managers' households. Cannot mint tokens for other
  managers.
- **Compromised server / DB access.** Sees everything —
  the graph, all household state, and (today) the plaintext
  credentials. This is the reason the credential encryption
  gap is 🔴.
- **Malicious agent output.** The LLM could produce content
  designed to trick a manager (e.g. a drafted email with a
  bad URL). The approval queue is the mitigation — no
  agent-drafted communication sends without a manager click.

**What we're protecting:**
- Household graph (who lives where, what they own, what's
  scheduled).
- Documents attached to nodes (passport photos, insurance
  policies, tax records — the crown jewels).
- Delegated tokens (a compromised Gmail refresh token
  lets an attacker read + send mail as the customer).
- Audit trail integrity (proof of what happened).

**What we're not defending against right now:**
- A host compromise that leaks both the DB file and the
  process env. Credential ciphertext is safe from a disk-only
  attacker, but the master key lives in-process — see the
  🟢 credential-encryption entry above for the follow-up
  (KMS-wrapped per-row data keys).
- A compromised infrastructure operator (fly.io / AWS
  employee with your keys). Envelope encryption with the
  master key held elsewhere raises the bar; we don't have
  that yet.
- Side-channel attacks on the LLM (prompt injection from a
  synced email or document). The approval queue is the
  fallback — nothing agent-authored executes autonomously
  without a policy that explicitly permits it. Prompt-
  injection-hardening the extraction path is a follow-up.
