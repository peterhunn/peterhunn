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

### 🔴 Credentials at rest are plaintext

- `packages/db/src/schema/credentials.ts` stores the credential
  blob as JSON in a `text` column. This includes Google refresh
  tokens, Twilio auth tokens, and any other delegated secret the
  platform holds.
- Anyone with read access to the SQLite file (or the Postgres
  row later) can lift them.

**Fix (blocks customer #1):** envelope encryption. Master key
in `ATELIER_CREDENTIAL_KEY` (32 bytes hex, from env or a KMS),
per-row data key wrapped by it. AES-256-GCM. `credentialRepo`
transparently decrypts on `getSecret`, encrypts on `store` and
`updateAccessToken`. Existing rows migrate on first read.

### 🔴 Bearer tokens have no expiry, no rotation, no revocation

- `mintToken` returns a token that lives forever. The `revokedAt`
  column exists but nothing populates it beyond manual admin work.
- No rotation flow. Compromised token = compromised account until
  someone notices and hand-revokes.

**Fix (blocks customer #1):** either (a) short-lived JWTs signed
by a rotating key with a refresh-token flow, or (b) database-backed
sessions with expiry + explicit rotation on privilege change.
Recommendation: (b) — simpler, gives us revocation for free, no
key-rotation infrastructure needed. Long-term (b) → passkeys
(`@simplewebauthn/server`) for managers, phone-verified access
for customers.

### 🔴 No rate limiting

- `/messaging/inbound/twilio` (public), `/messaging/inbound/mock`
  (public), and every household-scoped route are unthrottled.
- A misbehaving caller can flood the planner, spend LLM budget,
  fill the audit log.

**Fix (before public beta):** `@fastify/rate-limit`. Different
limits per surface. Public webhooks strict (per source IP), API
routes moderate (per bearer token), the planner surface stricter
than reads.

### 🟡 Cost caps are soft

- The router demotes to the declared min tier when over budget,
  then keeps running. There's no hard "stop spending" gate.
- A runaway agent (say, `research.query` that loops fetching URLs)
  can burn through the T3 daily allotment.

**Fix (before public beta):** hard-fail when over budget + N%
overshoot. Log and refuse the model call rather than degrade.
Requires a "budget exceeded, human review needed" surface in
the console.

### 🟡 No SIEM / audit export

- Audit events live in `audit_events` inside the app database.
  No streaming to an external system.
- If the DB is compromised, the audit trail is compromised.

**Fix (before compliance conversation):** append-only export to
an external store (S3 with object-lock, or a WORM-configured
bucket). Also a real-time hook that pushes to a customer's own
SIEM if they ask.

### 🟡 No secret scanning on commits

- Nothing scans commits for accidentally-committed API keys.

**Fix (cheap, do now):** enable GitHub's built-in secret
scanning + push protection on the repo. Add a `.gitleaks.toml`
that runs in CI.

### 🟡 OAuth state secret has no rotation infrastructure

- If `ATELIER_OAUTH_STATE_SECRET` is rotated, in-flight consent
  redirects break. Accepted trade-off but there's no dual-secret
  verification window.

**Fix (before scaling):** accept the previous secret as a
fallback for a rotation window. Roll on a schedule.

### 🟡 No HSTS, no CSP, no security headers

- Fastify serves plain HTTP responses. Nothing enforces HTTPS,
  frame-ancestors, content-type-sniffing, etc.

**Fix (before public):** `@fastify/helmet`. Sensible defaults
close a dozen small headers audits.

### 🟡 CORS wide-open

- No CORS policy declared. The API accepts requests from any
  origin.

**Fix (before public browser use beyond localhost):**
`@fastify/cors` with an explicit origin allowlist.

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
- A determined attacker with disk access — see the
  credential-encryption gap.
- A compromised infrastructure operator (fly.io / AWS
  employee with your keys). Envelope encryption with the
  master key held elsewhere raises the bar; we don't have
  that yet.
- Side-channel attacks on the LLM (prompt injection from a
  synced email or document). The approval queue is the
  fallback — nothing agent-authored executes autonomously
  without a policy that explicitly permits it. Prompt-
  injection-hardening the extraction path is a follow-up.
