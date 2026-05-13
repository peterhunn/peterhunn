#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { InMemoryStore } from "./store.js";
import { InMemoryApiKeyStore } from "./auth.js";
import { InMemoryAuditLog } from "./audit.js";
import { InMemoryWebhookStore } from "./webhooks.js";
import { ObligationExecutor } from "./executor.js";
import { ContractRegistry } from "./registry.js";
import type { ContractStore } from "./store.js";
import type { ApiKeyStore } from "./auth.js";
import type { AuditLog } from "./audit.js";
import type { WebhookStore } from "./webhooks.js";
import type { LLMClient } from "@x490/agents";

export interface ServerOptions {
  registry: ContractRegistry;
  llm: LLMClient;
  store?: ContractStore;
  apiKeys?: ApiKeyStore;
  audit?: AuditLog;
  webhooks?: WebhookStore;
  port?: number;
  host?: string;
  /** How often the obligation executor polls for due obligations (ms). Default 60 000. */
  executorIntervalMs?: number;
  /** Set false to disable the obligation executor entirely. Default true. */
  executor?: boolean;
}

/**
 * Start a Node.js HTTP server with auth, audit, webhooks, obligation executor,
 * and all contract routes. All stores default to in-memory implementations —
 * swap any for Postgres equivalents by passing them in options.
 */
export function startServer(options: ServerOptions): void {
  const {
    registry,
    llm,
    store = new InMemoryStore(),
    apiKeys = new InMemoryApiKeyStore(),
    audit = new InMemoryAuditLog(),
    webhooks = new InMemoryWebhookStore(),
    port = 3000,
    host = "0.0.0.0",
    executorIntervalMs = 60_000,
    executor: runExecutor = true,
  } = options;

  const app = createApp({ registry, store, llm, apiKeys, audit, webhooks });

  if (runExecutor) {
    const executor = new ObligationExecutor(registry, store, audit, webhooks);
    executor.start(executorIntervalMs);
  }

  serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    const base = `http://${info.address === "0.0.0.0" ? "localhost" : info.address}:${info.port}`;
    console.log(`\nLegal Agent API  →  ${base}`);
    const types = registry.types();
    if (types.length > 0) {
      for (const t of types) {
        console.log(
          `  ${t}  →  ${base}/contracts/${t}/{draft,parse,analyze,compliance,negotiate,activate}`,
        );
      }
    }
    console.log(`\n  Keys       →  POST/GET ${base}/keys`);
    console.log(`  Webhooks   →  POST/GET ${base}/webhooks`);
    console.log(`  Executor   →  polling every ${executorIntervalMs / 1000}s`);
  });
}

// ── Standalone entry point ────────────────────────────────────────────────────
// Runs when executed directly: `node dist/server.js` or `x490-api`.
// Reads configuration from environment variables.

const PORT = Number(process.env["PORT"] ?? 3000);
const BASE_URL = process.env["BASE_URL"] ?? `http://localhost:${PORT}`;
const DATABASE_URL = process.env["DATABASE_URL"];
const LLM_PROVIDER = process.env["LLM_PROVIDER"] ?? "anthropic";
const LLM_MODEL = process.env["LLM_MODEL"] ?? "claude-opus-4-7";

async function buildStores(): Promise<{
  store: ContractStore;
  apiKeys: ApiKeyStore;
  audit: AuditLog;
  webhooks: WebhookStore;
}> {
  if (DATABASE_URL) {
    // Production: Postgres-backed stores — dynamic import keeps the driver
    // out of the bundle when DATABASE_URL is not set.
    const { default: postgres } = await import("postgres");
    const {
      PostgresContractStore,
      PostgresApiKeyStore,
      PostgresAuditLog,
      PostgresWebhookStore,
    } = await import("@x490/store-postgres");

    const sql = postgres(DATABASE_URL, {
      max: Number(process.env["DB_POOL_SIZE"] ?? "10"),
      idle_timeout: 30,
      connect_timeout: 10,
    });

    return {
      store: new PostgresContractStore(sql),
      apiKeys: new PostgresApiKeyStore(sql),
      audit: new PostgresAuditLog(sql),
      webhooks: new PostgresWebhookStore(sql),
    };
  }

  // Development / demo: in-memory (data lost on restart)
  console.warn("⚠️  No DATABASE_URL — using in-memory stores. Data will not persist.");
  return {
    store: new InMemoryStore(),
    apiKeys: new InMemoryApiKeyStore(),
    audit: new InMemoryAuditLog(),
    webhooks: new InMemoryWebhookStore(),
  };
}

async function buildLlm(): Promise<LLMClient> {
  if (LLM_PROVIDER === "anthropic") {
    // Dynamic import keeps @anthropic-ai/sdk optional — it is a peer dep of
    // @x490/agents and must not be listed as a regular dep here.
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const { AnthropicClient } = await import("@x490/agents");
    return new AnthropicClient(new Anthropic(), LLM_MODEL);
  }
  throw new Error(
    `Unknown LLM_PROVIDER: "${LLM_PROVIDER}". Supported providers: anthropic`,
  );
}

const [stores, llm] = await Promise.all([buildStores(), buildLlm()]);

// Contract registry starts empty at boot time — that is intentional.
// Register contract types at startup via environment config or plugins
// before the first request arrives.
const registry = new ContractRegistry();

const executorIntervalMs = Number(process.env["EXECUTOR_INTERVAL_MS"] ?? 60_000);
const app = createApp({ registry, llm, ...stores });
const executor = new ObligationExecutor(registry, stores.store, stores.audit, stores.webhooks);
executor.start(executorIntervalMs);

serve({ fetch: app.fetch, port: PORT }, () => {
  const backend = DATABASE_URL ? "postgres" : "in-memory";
  console.log(`x490 api (${backend}, llm=${LLM_PROVIDER}/${LLM_MODEL}) listening on ${BASE_URL}`);
  console.log(`  Note: registry starts empty — register contract types before use`);
  console.log(`  GET    ${BASE_URL}/contracts                         list registered types`);
  console.log(`  POST   ${BASE_URL}/contracts/:type/draft             data → text`);
  console.log(`  POST   ${BASE_URL}/contracts/:type/parse             text → data`);
  console.log(`  POST   ${BASE_URL}/contracts/:type/analyze           text → ContractAnalysis`);
  console.log(`  POST   ${BASE_URL}/contracts/:type/compliance        text + requirements → ComplianceResult`);
  console.log(`  POST   ${BASE_URL}/contracts/:type/negotiate         text + perspective? → suggestions`);
  console.log(`  POST   ${BASE_URL}/contracts/:type/activate          data → { contractId, state }`);
  console.log(`  GET    ${BASE_URL}/contracts/:contractId/state       → { contractId, contractType, state }`);
  console.log(`  POST   ${BASE_URL}/contracts/:contractId/events      eventType + party → { state, result }`);
  console.log(`  GET    ${BASE_URL}/contracts/:contractId/audit       → AuditEntry[]`);
  console.log(`  POST   ${BASE_URL}/keys                              create API key`);
  console.log(`  GET    ${BASE_URL}/keys                              list API keys`);
  console.log(`  DELETE ${BASE_URL}/keys/:id                          revoke API key`);
  console.log(`  POST   ${BASE_URL}/webhooks                          register webhook`);
  console.log(`  GET    ${BASE_URL}/webhooks                          list webhooks`);
  console.log(`  DELETE ${BASE_URL}/webhooks/:id                      delete webhook`);
  console.log(`  Executor: polling every ${executorIntervalMs / 1000}s`);
});
