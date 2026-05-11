import { Hono } from "hono";
import type { LLMClient } from "@legal-agents/agents";
import type { ContractRegistry } from "./registry.js";
import type { ContractStore } from "./store.js";
import type { ApiKeyStore } from "./auth.js";
import type { AuditLog } from "./audit.js";
import type { WebhookStore } from "./webhooks.js";
export interface AppOptions {
    registry: ContractRegistry;
    store: ContractStore;
    llm: LLMClient;
    apiKeys: ApiKeyStore;
    audit: AuditLog;
    webhooks: WebhookStore;
}
type AppVariables = {
    orgId: string;
    keyId: string;
    mode: "live" | "test";
    /** partyId bound to this key, or "" if the key is not party-specific. */
    partyId: string;
};
/**
 * Creates the Hono app with auth, audit, webhooks, and all contract routes.
 *
 * Auth:     Authorization: Bearer sk_live_xxx  (required on every request)
 * Audit:    every state-changing call is recorded to the audit log
 * Webhooks: contract.activated / contract.event.processed fire after mutations
 *
 * Routes:
 *
 *   GET  /contracts                         list registered types
 *
 *   POST /contracts/:type/draft             data → text
 *   POST /contracts/:type/parse             text → data
 *   POST /contracts/:type/analyze           text → ContractAnalysis
 *   POST /contracts/:type/compliance        text + requirements → ComplianceResult
 *   POST /contracts/:type/negotiate         text + perspective? → suggestions
 *
 *   POST /contracts/:type/activate          data → { contractId, state }
 *   GET  /contracts/:contractId/state       → { contractId, contractType, state }
 *   POST /contracts/:contractId/events      eventType + party → { state, result }
 *   GET  /contracts/:contractId/audit       → AuditEntry[]
 *
 *   POST /keys                              create API key → { key, raw }
 *   GET  /keys                              list API keys
 *   DELETE /keys/:id                        revoke API key
 *
 *   POST /webhooks                          register webhook → { webhook, secret }
 *   GET  /webhooks                          list webhooks
 *   DELETE /webhooks/:id                    delete webhook
 */
export declare function createApp(options: AppOptions): Hono<{
    Variables: AppVariables;
}>;
export {};
//# sourceMappingURL=app.d.ts.map