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

## EVM features (optional)

All EVM features are opt-in. They activate only when the relevant env vars are set **and** the accepting party supplies a valid Ethereum address in `partyData.walletAddress`.

### EIP-712 signed credential

When `EIP712_SIGNER_KEY` is set, the facilitator signs the agreement with EIP-712 typed data and returns an `eip712Credential` field alongside the HMAC token. Any EVM-compatible verifier can validate it without calling back to the facilitator.

| Variable | Default | Description |
|----------|---------|-------------|
| `EIP712_SIGNER_KEY` | — | `0x`-prefixed hex private key used to sign EIP-712 credentials |
| `EIP712_CHAIN_ID` | `1` | EVM chain ID encoded in the EIP-712 domain separator |

### ERC-721 agreement NFT

When all three NFT env vars are set, the facilitator mints an ERC-721 token to the party's wallet after acceptance (fire-and-forget — does not block the response). The token ID is derived from `keccak256(contractId)`.

| Variable | Default | Description |
|----------|---------|-------------|
| `EVM_RPC_URL` | — | JSON-RPC endpoint (e.g. `https://mainnet.base.org`) |
| `NFT_CONTRACT_ADDRESS` | — | Deployed ERC-721 contract with a `mint(address, uint256)` function |
| `MINTER_PRIVATE_KEY` | — | `0x`-prefixed hex private key authorised to call `mint` |
