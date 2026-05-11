import type { ContractRegistry } from "./registry.js";
import type { ContractStore } from "./store.js";
import type { AuditLog } from "./audit.js";
import type { WebhookStore } from "./webhooks.js";
/**
 * Sentinel UUID used as the keyId in audit entries written by the executor.
 * Never matches a real API key — the Postgres FK resolves to NULL.
 */
export declare const SYSTEM_KEY_ID = "00000000-0000-0000-0000-000000000000";
/**
 * ObligationExecutor — the scheduler that makes contracts live.
 *
 * Polls `store.findWithDueObligations()` on a configurable interval.
 * For each obligation whose deadline has passed with status "pending":
 *
 *   1. Calls `logic.onObligationDue(obligation, ctx)` if implemented,
 *      otherwise fires a generic OBLIGATION_DUE event via `logic.execute()`.
 *   2. Persists updated contract state.
 *   3. Records the action to the audit DAG (actor = SYSTEM_KEY_ID).
 *   4. Fires `obligation.status.changed` and (if applicable)
 *      `contract.status.changed` webhooks.
 *
 * This is what transforms contracts from passive records into active programs:
 * once activated, a contract advances itself as time passes.
 */
export declare class ObligationExecutor {
    private readonly registry;
    private readonly store;
    private readonly audit;
    private readonly webhooks;
    private timer;
    constructor(registry: ContractRegistry, store: ContractStore, audit: AuditLog, webhooks: WebhookStore);
    /** Start polling on the given interval (default 60 s). */
    start(intervalMs?: number): void;
    stop(): void;
    /** Single execution pass — process all currently due obligations. */
    tick(): Promise<void>;
    private processContract;
}
//# sourceMappingURL=executor.d.ts.map