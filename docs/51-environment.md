# Environment reference

Every environment variable the platform reads, what it does, and
when it's required. Canonical shape lives in
[`platform/.env.example`](../platform/.env.example) — this doc
is the narrative version.

## Required to boot the API

| Name                                | Purpose                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| `ATELIER_CREDENTIAL_KEY`            | 32-byte hex key wrapping every stored credential blob at rest (AES-256-GCM).  |

Generate one with `openssl rand -hex 32`. The API refuses to
start if it's missing or malformed — `credentialRepo` throws at
construction. See [`40-security.md`](./40-security.md#🟢-credentials-at-rest-are-encrypted).

## Required for a real deploy

| Name                                    | Purpose                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `ATELIER_OAUTH_STATE_SECRET`            | HMAC key signing the Google OAuth state parameter. ≥16 chars.            |
| `ATELIER_TWILIO_AUTH_TOKEN`             | Twilio account auth token — also drives inbound webhook signature verify. |
| `ATELIER_PASSKEY_ORIGIN`                | Console origin (`https://console.…`) — WebAuthn origin pin.              |
| `ATELIER_PASSKEY_RP_ID`                 | Console hostname (bare, no scheme). WebAuthn RP-ID pin.                  |

Missing `ATELIER_OAUTH_STATE_SECRET` blocks the OAuth consent
routes at request time (the config endpoint reports
`configured: false`). Missing `ATELIER_TWILIO_AUTH_TOKEN` puts
the inbound webhook into dev mode with a one-line notice —
never leave it unset in production.

## LLM providers

At least one is needed for real model calls; without any, the
router falls back to the mock adapter and logs the reason on
every response.

| Name                             | Purpose                                                            |
| -------------------------------- | ------------------------------------------------------------------ |
| `ANTHROPIC_API_KEY`              | Anthropic (Claude) API.                                            |
| `OPENAI_API_KEY`                 | OpenAI (GPT / o1) API.                                             |
| `OPENAI_BASE_URL`                | Optional — point the OpenAI adapter at any OpenAI-compatible host. |
| `GOOGLE_API_KEY`                 | Gemini API.                                                        |
| `ATELIER_LLM_<SLUG>_URL`         | OpenAI-compatible endpoint for `provider = openai_compatible:<slug>`. |
| `ATELIER_LLM_<SLUG>_KEY`         | Auth key for the same slug. Ollama needs no key.                   |

Registered slugs today: `OLLAMA`, `TOGETHER`, `GROQ`,
`FIREWORKS`, `VLLM`. Add a new slug by (a) setting the two env
vars, (b) adding a row to the model registry pointing at
`openai_compatible:<slug>`. See
[`24-model-routing.md`](./24-model-routing.md).

## Google OAuth (Calendar + Gmail)

| Name                                     | Purpose                                                                     |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `GOOGLE_OAUTH_CLIENT_ID`                 | OAuth 2.0 client id from Google Cloud Console.                              |
| `GOOGLE_OAUTH_CLIENT_SECRET`             | OAuth 2.0 client secret.                                                    |
| `GOOGLE_OAUTH_REDIRECT_URI`              | Full callback URL registered with Google. Default: `http://localhost:3001/oauth/google/callback`. |
| `ATELIER_OAUTH_STATE_SECRET_PREVIOUS`    | Optional — previous secret accepted verify-only for a rotation window.       |
| `ATELIER_CONSOLE_URL`                    | Origin the OAuth flow redirects back to when returnTo is absent.             |

## Customer messaging (Twilio SMS / WhatsApp)

**Concierge line** (shared across every household in a tenant):

| Name                                     | Purpose                                                       |
| ---------------------------------------- | ------------------------------------------------------------- |
| `ATELIER_TWILIO_ACCOUNT_SID`             | Twilio account SID.                                           |
| `ATELIER_TWILIO_AUTH_TOKEN`              | Twilio auth token — also drives inbound + status webhook signature verify. |
| `ATELIER_TWILIO_FROM_NUMBER`             | Concierge phone number (`+1…`).                               |
| `ATELIER_TWILIO_MESSAGING_SERVICE_SID`   | Optional — use a Messaging Service instead of a fixed number. |
| `ATELIER_TWILIO_STATUS_CALLBACK_URL`     | Optional — public URL Twilio POSTs delivery-status updates to (`/messaging/status/twilio`). Unset = no callbacks; deliveryStatus stays null on outbound rows. |

Per-household Twilio credentials (for enterprise households with
their own DID) are stored on `credentials` under provider
`"twilio"`, kind `"api_key"`, and take precedence over the
platform-level env when set. See
[`32-customer-messaging.md`](./32-customer-messaging.md).

## Passkeys (WebAuthn)

| Name                        | Purpose                                                     |
| --------------------------- | ----------------------------------------------------------- |
| `ATELIER_PASSKEY_ORIGIN`    | Full origin the browser sees. `http://localhost:3000` in dev. |
| `ATELIER_PASSKEY_RP_ID`     | Bare hostname. `localhost` in dev.                          |
| `ATELIER_PASSKEY_RP_NAME`   | Human-facing name in the browser prompt. Default `ATELIER`. |

A wrong `RP_ID` in prod fails closed — every ceremony refuses.
Set to the console host (not the API host).

## Rate limiting

| Name                             | Purpose                                                                   |
| -------------------------------- | ------------------------------------------------------------------------- |
| `ATELIER_RATE_LIMIT_MAX`         | Global cap per (bearer OR client IP). Default 120.                        |
| `ATELIER_RATE_LIMIT_WINDOW`      | Window duration. Default `"1 minute"`.                                    |

Public webhooks have stricter per-route overrides set in code:
60/min for `/messaging/inbound/*`, 20/min for
`/oauth/google/callback`, 30/min for `/oauth/google/config`,
10/min for `/webauthn/register/*`, 20/min for
`/webauthn/login/*`. `/healthz` is skipped so uptime probes
don't burn the budget.

## CORS

| Name                          | Purpose                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `ATELIER_CORS_ORIGINS`        | Comma-separated allowlist. Falls back to `ATELIER_CONSOLE_URL` (or `http://localhost:3000`). |

`credentials: true` is always on; `@fastify/cors` refuses to
combine that with a wildcard, so an origin must be an exact
match — no accidental full-open.

## Inference cost cap

| Name                               | Purpose                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| `ATELIER_BUDGET_HARD_MULTIPLE`     | Ratio above the tier cap that triggers `BudgetExceededError`. Default 1.5. Must be ≥ 1.    |

The soft over-budget path (demote to declared min tier) still
runs at ratio ≥ 1.0. At `ratio ≥ ATELIER_BUDGET_HARD_MULTIPLE`
`callModel` throws before selection — a runaway agent can't drain
the account past this line. See
[`52-observability.md`](./52-observability.md).

## Audit export

| Name                                     | Purpose                                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| `ATELIER_AUDIT_EXPORT_ENABLED`           | `1` (default) / `0` for tests and one-shot workers.                                     |
| `ATELIER_AUDIT_EXPORT_SINK`              | `file` (default) / `s3` / `webhook`. Webhook not yet implemented.                        |
| `ATELIER_AUDIT_EXPORT_DIR`               | File sink output directory. Default `./data/audit-export`.                               |
| `ATELIER_AUDIT_EXPORT_S3_BUCKET`         | S3 sink bucket name — required when SINK=s3.                                              |
| `ATELIER_AUDIT_EXPORT_S3_PREFIX`         | Optional prefix inside the bucket. Default `atelier/audit`.                               |
| `ATELIER_AUDIT_EXPORT_S3_REGION`         | Optional region hint for the SDK.                                                         |
| `ATELIER_AUDIT_EXPORT_INTERVAL_SECONDS`  | Tick interval. Default 60. Min 5s.                                                        |
| `ATELIER_AUDIT_EXPORT_BATCH_SIZE`        | Max events per batch. Default 500.                                                        |

## Background scheduler

| Name                              | Purpose                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ATELIER_SYNC_ENABLED`            | `1` (default) / `0`. Turns off the Gmail/Calendar sync loop.                                                                                    |
| `ATELIER_SYNC_INTERVAL_SECONDS`   | Tick interval. Default 300 (5 min). Floored to 5s.                                                                                              |
| `ATELIER_AUTOPILOT_ENABLED`       | `1` (default) / `0`. Off = fresh Gmail/Calendar items don't auto-dispatch to agents.                                                            |
| `ATELIER_PLAYBOOKS_ENABLED`       | `1` (default) / `0`. Off = the playbook runner doesn't fire due playbooks alongside sync ticks.                                                 |

## Web tools (Research agent)

Optional. The web adapter tries providers in order:
Tavily → Serper → Brave → mock.

| Name                       | Purpose                                                          |
| -------------------------- | ---------------------------------------------------------------- |
| `TAVILY_API_KEY`           | Tavily search API.                                               |
| `SERPER_API_KEY`           | Serper search API.                                               |
| `BRAVE_SEARCH_API_KEY`     | Brave search API.                                                |
| `JINA_API_KEY`             | Jina Reader for higher fetch rate limits (optional).             |
| `ATELIER_DISABLE_JINA`     | `1` to skip Jina Reader entirely and use raw fetch only.         |

## Document uploads

| Name                            | Purpose                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `ATELIER_BLOB_DIR`              | Root directory for the content-addressed blob store. Default `./packages/db/data/blobs`.            |
| `ATELIER_MAX_UPLOAD_BYTES`      | Per-request upload cap. Default 25 MiB — also raises the Fastify `bodyLimit`.                        |

Phase-0 backend is local disk with a two-level shard prefix by
sha256. S3 with server-side encryption is the follow-up backend.

## Local dev

| Name              | Purpose                                                                        |
| ----------------- | ------------------------------------------------------------------------------ |
| `ATELIER_DB_URL`  | SQLite path. Default `./packages/db/data/atelier.db`. Use `:memory:` for tests. |
| `PORT`            | API port. Default 3001.                                                        |
| `HOST`            | API bind address. Default 0.0.0.0.                                             |
| `LOG_LEVEL`       | Fastify log level. Default `info`.                                             |

## Console-only

The Next.js console reads a small set of build-time / runtime
env vars:

| Name                | Purpose                                                                       |
| ------------------- | ----------------------------------------------------------------------------- |
| `ATELIER_API_URL`   | Where the console proxies API calls. Default `http://localhost:3001`.         |

Session tokens live in an httpOnly cookie named `atelier_token`
set from the Next.js server handlers. Not an env var; noted here
because operators occasionally ask what "the session" is stored as.

## What's NOT set via env

Things that live in the database, not the environment:

- **Per-household autonomy caps** — on the `households` row.
- **Per-household Twilio credentials** — on `credentials`.
- **Per-household Google credentials** — on `credentials`.
- **Policy set** — on `policies`.
- **Model registry** — code (`ModelRegistry` in
  `packages/router/src/registry.ts`); may move to a config
  table in a later phase.
