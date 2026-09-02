# Authentication

Who can talk to the API, how they prove it, and how those
credentials are lifecycled. Manager surface, machine surface,
customer surface.

Adjacent reading: [`40-security.md`](./40-security.md) for the
threat model, [`32-customer-messaging.md`](./32-customer-messaging.md)
for how customers are identified without an auth credential.

## Manager surface

Managers are the humans who run households. Every household is
scoped to one primary manager with an optional backup. Managers
authenticate through one of two credential types.

### 1. Bearer tokens

The original manager credential. Still supported for scripting,
CI, and first-time bootstrap.

- Minted via `identityRepo.mintToken({ actorType, actorId,
  label, ttlSeconds? })`. Default TTL is 90 days; the seed
  script mints a 1-year dev token by passing `ttlSeconds`
  explicitly.
- Token format: `atl_<64 hex>` (32 bytes of random, base64url).
  Returned to the caller once — plaintext is never persisted.
- Stored as SHA-256 hash. `resolveToken(token)` hashes the
  presented value and looks up the row.
- Return shape is a discriminated union
  `{ ok: true, actor, tokenId } | { ok: false, reason:
  "invalid" | "expired" | "revoked" }`. The auth plugin surfaces
  the reason in the 401 body so clients can react appropriately
  (re-auth vs. rotate vs. session-was-killed).
- Every successful `resolveToken` stamps `last_used_at` so
  "haven't touched this token in 60 days — safe to revoke?"
  becomes an answerable question.

Lifecycle endpoints:

| Endpoint                          | What it does                                    |
| --------------------------------- | ----------------------------------------------- |
| `GET  /me/tokens`                 | List metadata for tokens owned by the caller.   |
| `POST /me/tokens/rotate`          | Revoke current, mint fresh — same actor + label.|
| `POST /me/tokens/:id/revoke`      | Mark one token revoked. Owner-only.             |

### 2. Passkeys (WebAuthn)

The primary manager credential. Replaces the paste-a-token
flow on the console; bearer tokens stay for machine use.

- `@simplewebauthn/server` on the API, `@simplewebauthn/browser`
  on the console.
- Four routes on the API:
  - `POST /webauthn/register/options` (auth) →
    `{ options, challengeId }`
  - `POST /webauthn/register/verify` (auth) → `201 { credential }`
  - `POST /webauthn/login/options` (public) →
    `{ options, challengeId }`
  - `POST /webauthn/login/verify` (public) →
    `{ token, tokenId, expiresAt }`
- Also `GET /me/passkeys` and `DELETE /me/passkeys/:id`.
- Login-verify mints a fresh bearer with a 12-hour TTL. The
  Next.js route handler stashes it in the same httpOnly session
  cookie the paste-a-bearer flow uses, so every downstream
  route treats a passkey login exactly like any other.

Storage:

- `manager_credentials` — one row per registered device: raw
  credentialId (globally unique across the RP), public key,
  signature counter, transports, device label, createdAt,
  lastUsedAt.
- `webauthn_challenges` — ephemeral single-use store, keyed by
  a `wac_<hex>` id we hand back to the browser. Every row
  expires after 5 minutes; a sweep of expired rows runs on
  every new issue so no cleanup timer is needed.

Hardening:

- User-enumeration: `/webauthn/login/options` for an unknown
  email still returns a valid options object with
  `allowCredentials: []`. Timing / shape are indistinguishable
  from a registered account.
- Cross-owner delete is a SQL-level no-op — the `DELETE
  /me/passkeys/:id` WHERE pins to the calling manager, so
  nobody can nuke another manager's passkeys.
- Signature counter is stored per-credential and checked on
  every login via `authenticationInfo.newCounter`. The SDK
  itself catches non-monotonic counters and throws; we surface
  that as 401 verification_failed.
- Origin + RP-ID are pinned via `ATELIER_PASSKEY_ORIGIN` and
  `ATELIER_PASSKEY_RP_ID`. Browsers refuse to complete a
  ceremony if the calling page's origin doesn't match, so a
  wrong RP_ID in prod fails closed rather than fails open.

Bootstrap sequence for a new manager:
1. Seed script mints a bearer token (or an existing manager
   creates one via `/me/tokens/rotate`).
2. New manager logs in once with the bearer.
3. Navigates to `/passkeys` and registers a device.
4. Signs out. All subsequent logins are passkey-first.

## Household grants

Authentication answers "who are you." Grants answer "what can
you touch." Every household-scoped route (`/households/:id/...`)
checks `resolution.actor.householdIds.includes(householdId)`
before the handler runs. Missing grant = 403 `household_forbidden`
before any data is loaded.

Grants live in `household_grants` (managerId, householdId, role
∈ `primary | backup`, grantedAt, revokedAt). The auth plugin's
`Actor.householdIds` is populated from a JOIN at token-resolve
time — one query per request.

Manager transfer: primary role is a single row. Transfer =
revoke the outgoing grant + insert a new primary grant. The
household stays continuous; only the accountable name changes.

## Customer surface

Customers don't have accounts. They are identified by the
phone number they text from — one number → one profile →
one household. Full flow lives in
[`32-customer-messaging.md`](./32-customer-messaging.md); the
auth-relevant summary:

- No password, no login. The "credential" is the customer's
  own phone number, verified by them texting a 6-digit code
  during onboarding.
- Once verified, every inbound from that number is
  authenticated as `Actor { type: "customer", id: <person node
  id> }` when passed into the planner. The person node id, not
  the phone number, is the identity — a customer who changes
  phones gets a new endpoint bound to the same profile.
- Consent (opted_in / opted_out) is a parallel gate to
  authentication. Opted-out endpoints can still text (we don't
  refuse inbound), but the planner is not dispatched and
  outbound is refused.

Customer portal auth (SMS OTP, passkeys) is deliberately not
built yet — the customer portal itself doesn't exist. When it
does, passkeys are the assumed default, matching the manager
surface.

## Machine-to-machine

Bearer tokens continue to be the M2M credential:

- Scripts (`scripts/seed.ts`, CI jobs, manual data fixes).
- Third-party integrations calling the API on behalf of a
  household (rare; none in production today).
- Backfill / migration scripts.

For a machine token: mint via `identityRepo.mintToken(...)`
with a short TTL and a specific label so the operator can find
and revoke it later. Store it in the environment of the
process that uses it, not in the codebase.

## What we deliberately don't have

- **Password login for managers.** Bearer + passkey covers the
  cases; passwords add attack surface without adding capability.
- **OAuth / SAML SSO for managers.** Considered for enterprise
  sales; not built. When it is, it'll federate into the same
  `identityRepo.mintToken` path, minting a short-TTL token per
  SSO session.
- **API keys separate from bearer tokens.** Bearer tokens
  already carry a label and lifecycle; a second "API key"
  concept would duplicate them.
- **Impersonation.** A manager cannot act as another manager,
  and no ATELIER staff role can act as the customer's manager.
  When one manager needs to cover another (PTO, offboarding),
  it's a grant transfer, not an impersonation session.

## Reference: request flow

```
Client ──── Authorization: Bearer atl_… ────▶ auth plugin
                                                   │
                                                   ▼
                                     identity.resolveToken(token)
                                                   │
                                        ┌──────────┴─────────┐
                                        ▼                    ▼
                              { ok: true, actor }   { ok: false, reason }
                                        │                    │
                              req.actor = actor       reply 401 { error:
                                        │                     `${reason}_token` }
                              householdId path?
                                        │
                     ┌──────────────────┴──────────────────┐
                     │                                     │
                  no grant                              has grant
                     │                                     │
                reply 403                           req.householdContext
                                                          │
                                                    handler runs
                                                          │
                                                          ▼
                                                  audit hook records
                                                  the successful call
```
