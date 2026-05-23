# @x490/dashboard

Next.js 14 operator dashboard for the x490 facilitator. Manage agreements, contract templates, requirements, API keys, webhooks, and pending multi-party contracts.

## Pages

| Route | Description |
|-------|-------------|
| `/agreements` | Browse, filter, revoke agreements; view contract event timeline |
| `/templates` | View registered contract templates and their terms |
| `/requirements` | Build `X-490-Requirements` headers with a form |
| `/keys` | Create and revoke facilitator API keys |
| `/webhooks` | Register webhook endpoints; view delivery attempt logs |
| `/pending-contracts` | Multi-party contracts awaiting acceptance |

## Setup

```bash
npm install
cp .env.local.example .env.local  # fill in Auth0 + facilitator URL
npm run dev                         # http://localhost:3001
```

## Env vars

| Variable | Description |
|----------|-------------|
| `AUTH0_SECRET` | Random secret (≥ 32 chars) used to encrypt session cookies |
| `AUTH0_BASE_URL` | Public URL of this app (e.g. `http://localhost:3001`) |
| `AUTH0_ISSUER_BASE_URL` | Auth0 tenant URL (e.g. `https://your-tenant.auth0.com`) |
| `AUTH0_CLIENT_ID` | Auth0 application client ID |
| `AUTH0_CLIENT_SECRET` | Auth0 application client secret |
| `FACILITATOR_URL` | Facilitator backend URL (default: `http://localhost:4901`) |

## Architecture

All API calls are proxied through `/api/facilitator/[...path]` which attaches the Auth0 access token as `Authorization: Bearer`. The facilitator's own auth validates that token.

Dark mode is supported via `next-themes` with system-default detection.

## Docker

```bash
docker build -t x490-dashboard .
docker run -p 3001:3001 --env-file .env x490-dashboard
```
