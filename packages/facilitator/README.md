# @x490/facilitator

Multi-tenant service that implements the x490 HTTP contracting protocol. Handles template registration, contract requirements, token issuance, verification, agreement management, and webhook delivery.

## Run

```bash
DATABASE_URL=postgres://user:pass@localhost/x490 \
BASE_URL=https://your-domain.example.com \
npm start
```

Default port: `4901`.

## Routes

### Public (no auth)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/tenants` | Sign up — returns `tenantId` and `apiKey` |
| `GET` | `/v1/templates/:hash` | Fetch template content by SHA-256 hash |
| `POST` | `/v1/:tenantId/accept` | Accept contract requirements → token |
| `GET` | `/v1/:tenantId/verify` | Verify a contract token |

### Operator (requires `X-API-Key`)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/templates` | Register a contract template |
| `POST` | `/v1/requirements` | Build requirements for a template |
| `GET` | `/v1/agreements` | List agreements |
| `POST` | `/v1/:tenantId/revoke` | Revoke an agreement |
| `GET/POST/DELETE` | `/v1/apikeys` | Manage operator API keys |
| `GET/POST/DELETE` | `/v1/webhooks` | Manage webhooks |
| `GET` | `/v1/webhooks/:id/deliveries` | Delivery attempt log |
| `GET` | `/v1/me` | Current tenant info |

## Token issuance flow

1. Caller GETs a protected resource → receives `490` with `X-490-Requirements` header
2. Caller POSTs `{ partyData, templateHash }` to `/v1/:tenantId/accept`
3. Facilitator verifies template hash, records the agreement, issues a signed JWT
4. Caller retries with `X-490-Contract: <token>`

## Webhooks

Events: `agreement.created`, `agreement.revoked`. Deliveries are signed with HMAC-SHA256 (`X-X490-Signature`), retried 3 times (0 s / +2 s / +4 s), and SSRF-protected.

## Env vars

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4901` | Listen port |
| `BASE_URL` | — | Public base URL (required for template URLs) |
| `DATABASE_URL` | — | Postgres connection string; omit for in-memory |
| `AUTH0_DOMAIN` | — | Optional: Auth0 domain for operator JWT validation |
| `AUTH0_AUDIENCE` | — | Optional: Auth0 API audience |
| `DB_POOL_SIZE` | `10` | Postgres connection pool size |
| `RATE_LIMIT_*` | — | Per-route rate limit overrides |
