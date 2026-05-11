import type { ContractRegistry } from "./registry.js";
import type { ContractStore } from "./store.js";
import type { ApiKeyStore } from "./auth.js";
import type { AuditLog } from "./audit.js";
import type { WebhookStore } from "./webhooks.js";
import type { LLMClient } from "@legal-agents/agents";
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
export declare function startServer(options: ServerOptions): void;
//# sourceMappingURL=server.d.ts.map