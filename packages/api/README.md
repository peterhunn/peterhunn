# @x490/api

Hono-based REST API for contract management. Handles type operations (draft, parse, analyze, compliance, negotiate), contract lifecycle (activate, events, state), audit trails, API keys, and webhooks.

## Install

```bash
npm install @x490/api
```

## Usage

```ts
import { createApp } from "@x490/api";
import { InMemoryStore } from "@x490/api";
import { InMemoryApiKeyStore } from "@x490/api";
import { MerkleAuditLog, InMemoryWebhookStore } from "@x490/api";
import { ContractRegistry } from "@x490/api";
import { AnthropicClient } from "@x490/agents";
import Anthropic from "@anthropic-ai/sdk";

const registry = new ContractRegistry();
registry.register("nda", { model, template, logic });

const app = createApp({
  registry,
  store: new InMemoryStore(),
  llm: new AnthropicClient(new Anthropic(), "claude-sonnet-4-6"),
  apiKeys: new InMemoryApiKeyStore(),
  audit: new MerkleAuditLog(),
  webhooks: new InMemoryWebhookStore(),
});
```

## Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/contracts` | List registered contract types |
| `POST` | `/contracts/:type/draft` | `data` → rendered text |
| `POST` | `/contracts/:type/parse` | `text` → structured data |
| `POST` | `/contracts/:type/analyze` | `text` → `ContractAnalysis` |
| `POST` | `/contracts/:type/compliance` | `text + requirements` → `ComplianceResult` |
| `POST` | `/contracts/:type/negotiate` | `text` → negotiation suggestions |
| `POST` | `/contracts/:type/activate` | Activate contract instance |
| `GET` | `/contracts/:contractId/state` | Current contract state |
| `POST` | `/contracts/:contractId/events` | Submit event + advance state |
| `GET` | `/contracts/:contractId/audit` | Merkle-verified audit log |
| `POST` | `/keys` | Create API key |
| `GET` | `/keys` | List API keys |
| `DELETE` | `/keys/:id` | Revoke API key |
| `POST` | `/webhooks` | Register webhook (secret returned once) |
| `GET` | `/webhooks` | List webhooks |
| `DELETE` | `/webhooks/:id` | Delete webhook |
| `GET` | `/webhooks/:id/deliveries` | Delivery attempt log |

## Auth

All routes require `Authorization: Bearer sk_live_<key>` (or `sk_test_<key>`).

Keys with a bound `partyId` automatically attribute contract events to that party — the key is the agent's identity.

## Env vars (server mode)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Listen port |
| `BASE_URL` | `http://localhost:PORT` | Public base URL |
| `DATABASE_URL` | — | Postgres connection string; omit to use in-memory stores |
| `LLM_PROVIDER` | `anthropic` | LLM provider |
| `LLM_MODEL` | `claude-opus-4-7` | Model name |
| `ANTHROPIC_API_KEY` | — | Required when `LLM_PROVIDER=anthropic` |

## Webhooks

Webhook deliveries use HMAC-SHA256 (`X-Legal-Agents-Signature: sha256=<hex>`), retry up to 3 times with 0 s / 2 s / 4 s backoff, and reject private/loopback URLs (SSRF protection). Event types: `contract.activated`, `contract.event.processed`, `contract.status.changed`, `obligation.status.changed`.
