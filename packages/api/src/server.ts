import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { InMemoryStore } from "./store.js";
import { InMemoryApiKeyStore } from "./auth.js";
import { InMemoryAuditLog } from "./audit.js";
import { InMemoryWebhookStore } from "./webhooks.js";
import { ObligationExecutor } from "./executor.js";
import type { ContractRegistry } from "./registry.js";
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
