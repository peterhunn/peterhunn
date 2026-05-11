import { fanOut } from "./webhooks.js";
/**
 * Sentinel UUID used as the keyId in audit entries written by the executor.
 * Never matches a real API key — the Postgres FK resolves to NULL.
 */
export const SYSTEM_KEY_ID = "00000000-0000-0000-0000-000000000000";
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
export class ObligationExecutor {
    registry;
    store;
    audit;
    webhooks;
    timer = undefined;
    constructor(registry, store, audit, webhooks) {
        this.registry = registry;
        this.store = store;
        this.audit = audit;
        this.webhooks = webhooks;
    }
    /** Start polling on the given interval (default 60 s). */
    start(intervalMs = 60_000) {
        if (this.timer)
            return;
        // Run immediately, then on interval
        void this.tick();
        this.timer = setInterval(() => void this.tick(), intervalMs);
        // Don't keep the Node.js process alive just for this
        this.timer.unref?.();
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }
    /** Single execution pass — process all currently due obligations. */
    async tick() {
        const now = new Date();
        let due;
        try {
            due = await this.store.findWithDueObligations(now);
        }
        catch (err) {
            console.error("[executor] findWithDueObligations failed:", err);
            return;
        }
        for (const { contractId, stored } of due) {
            try {
                await this.processContract(contractId, stored, now);
            }
            catch (err) {
                console.error(`[executor] failed processing ${contractId}:`, err);
            }
        }
    }
    async processContract(contractId, stored, now) {
        const reg = this.registry.get(stored.contractType);
        if (!reg)
            return;
        const dueObligations = stored.state.obligations.filter((o) => o.status === "pending" &&
            o.deadline !== undefined &&
            new Date(o.deadline) <= now);
        if (dueObligations.length === 0)
            return;
        let state = stored.state;
        for (const obligation of dueObligations) {
            const prevStatus = obligation.status;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ctx = { data: stored.data, state, now };
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const response = reg.logic.onObligationDue
                ? reg.logic.onObligationDue(obligation, ctx)
                : reg.logic.execute(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                {
                    $class: `${stored.contractType}.OBLIGATION_DUE`,
                    eventId: crypto.randomUUID(),
                    timestamp: now.toISOString(),
                    party: obligation.party,
                    payload: {
                        obligationId: obligation.obligationId,
                        action: obligation.action,
                    },
                }, ctx);
            const newStatus = response.state.obligations.find((o) => o.obligationId === obligation.obligationId)?.status ?? "pending";
            const contractStatusChanged = response.state.status !== state.status;
            state = response.state;
            await Promise.all([
                this.audit.record({
                    orgId: stored.orgId,
                    keyId: SYSTEM_KEY_ID,
                    contractId,
                    action: "obligation.due",
                    payload: {
                        obligationId: obligation.obligationId,
                        action: obligation.action,
                        from: prevStatus,
                        to: newStatus,
                    },
                }),
                fanOut(this.webhooks, stored.orgId, "obligation.status.changed", {
                    contractId,
                    obligationId: obligation.obligationId,
                    from: prevStatus,
                    to: newStatus,
                }),
                contractStatusChanged
                    ? fanOut(this.webhooks, stored.orgId, "contract.status.changed", {
                        contractId,
                        from: stored.state.status,
                        to: state.status,
                    })
                    : Promise.resolve(),
            ]);
        }
        await this.store.set(contractId, { ...stored, state });
    }
}
//# sourceMappingURL=executor.js.map