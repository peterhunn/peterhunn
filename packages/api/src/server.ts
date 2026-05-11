import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { InMemoryStore } from "./store.js";
import type { ContractRegistry } from "./registry.js";
import type { ContractStore } from "./store.js";
import type { LLMClient } from "@legal-agents/agents";

export interface ServerOptions {
  registry: ContractRegistry;
  llm: LLMClient;
  store?: ContractStore;
  port?: number;
  host?: string;
}

/**
 * Start a Node.js HTTP server with all contract API routes mounted.
 *
 * Example:
 *   startServer({ registry, llm, port: 3000 });
 */
export function startServer(options: ServerOptions): void {
  const {
    registry,
    llm,
    store = new InMemoryStore(),
    port = 3000,
    host = "0.0.0.0",
  } = options;

  const app = createApp(registry, store, llm);

  serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    const base = `http://${info.address === "0.0.0.0" ? "localhost" : info.address}:${info.port}`;
    console.log(`Legal Agent API  →  ${base}/contracts`);
    const types = registry.types();
    if (types.length > 0) {
      for (const t of types) {
        console.log(`  ${t}  →  ${base}/contracts/${t}/{draft,parse,analyze,compliance,negotiate,activate}`);
      }
    } else {
      console.log("  (no contract types registered)");
    }
  });
}
