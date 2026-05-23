# @x490/store-postgres

PostgreSQL-backed store implementations for `@x490/api`. Drop-in replacements for the default in-memory stores, adding persistence, a Merkle-DAG audit trail, and webhook delivery tracking.

## Install

```bash
npm install @x490/store-postgres
```

## Stores

| Class | Interface | Description |
|-------|-----------|-------------|
| `PostgresContractStore` | `ContractStore` | Contract data and state in `contracts` table |
| `PostgresApiKeyStore` | `ApiKeyStore` | Hashed API keys with org + mode scoping |
| `PostgresAuditLog` | `AuditLog` | Merkle DAG — tamper-evident, verifiable |
| `PostgresWebhookStore` | `WebhookStore` | Webhook endpoints and subscriptions |
| `PostgresWebhookDeliveryStore` | `WebhookDeliveryStore` | Delivery attempts with retry tracking |

## Usage

```ts
import postgres from "postgres";
import {
  PostgresContractStore,
  PostgresApiKeyStore,
  PostgresAuditLog,
  PostgresWebhookStore,
  PostgresWebhookDeliveryStore,
} from "@x490/store-postgres";
import { createApp } from "@x490/api";

const sql = postgres(process.env.DATABASE_URL!);

const app = createApp({
  store: new PostgresContractStore(sql),
  apiKeys: new PostgresApiKeyStore(sql),
  audit: new PostgresAuditLog(sql),
  webhooks: new PostgresWebhookStore(sql),
  deliveries: new PostgresWebhookDeliveryStore(sql),
  // ... registry, llm
});
```

## Migrations

Run the bundled schema (idempotent — uses `IF NOT EXISTS` throughout):

```bash
DATABASE_URL=postgres://user:pass@localhost/x490 npm run migrate
```

Or import programmatically:

```ts
import { migrate } from "@x490/store-postgres";
await migrate(sql);
```

## Schema overview

- `organizations` — root tenant entity
- `api_keys` — scoped to org; `mode` (live/test); optional `party_id` binding
- `contracts` — `data` + `state` as JSONB
- `audit_log` — `hash` + `parent_hashes` (Merkle DAG); verifiable via `PostgresAuditLog.verify()`
- `audit_log_tips` — efficient current-tip tracking for DAG verification
- `webhooks` — per-org endpoint subscriptions
- `webhook_deliveries` — per-delivery `status_code`, `error`, `attempt_count`, `succeeded_at`
