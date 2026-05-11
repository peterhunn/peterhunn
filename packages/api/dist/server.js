import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { InMemoryStore } from "./store.js";
import { InMemoryApiKeyStore } from "./auth.js";
import { InMemoryAuditLog } from "./audit.js";
import { InMemoryWebhookStore } from "./webhooks.js";
import { ObligationExecutor } from "./executor.js";
/**
 * Start a Node.js HTTP server with auth, audit, webhooks, obligation executor,
 * and all contract routes. All stores default to in-memory implementations —
 * swap any for Postgres equivalents by passing them in options.
 */
export function startServer(options) {
    const { registry, llm, store = new InMemoryStore(), apiKeys = new InMemoryApiKeyStore(), audit = new InMemoryAuditLog(), webhooks = new InMemoryWebhookStore(), port = 3000, host = "0.0.0.0", executorIntervalMs = 60_000, executor: runExecutor = true, } = options;
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
                console.log(`  ${t}  →  ${base}/contracts/${t}/{draft,parse,analyze,compliance,negotiate,activate}`);
            }
        }
        console.log(`\n  Keys       →  POST/GET ${base}/keys`);
        console.log(`  Webhooks   →  POST/GET ${base}/webhooks`);
        console.log(`  Executor   →  polling every ${executorIntervalMs / 1000}s`);
    });
}
//# sourceMappingURL=server.js.map