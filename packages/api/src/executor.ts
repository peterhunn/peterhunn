import type { ContractResponse, Obligation } from "@legal-agents/core";
import type { ContractRegistry } from "./registry.js";
import type { ContractStore, StoredContract } from "./store.js";
import type { AuditLog } from "./audit.js";
import type { WebhookStore } from "./webhooks.js";
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
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly registry: ContractRegistry,
    private readonly store: ContractStore,
    private readonly audit: AuditLog,
    private readonly webhooks: WebhookStore,
  ) {}

  /** Start polling on the given interval (default 60 s). */
  start(intervalMs = 60_000): void {
    if (this.timer) return;
    // Run immediately, then on interval
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    // Don't keep the Node.js process alive just for this
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Single execution pass — process all currently due obligations. */
  async tick(): Promise<void> {
    const now = new Date();
    let due: Awaited<ReturnType<ContractStore["findWithDueObligations"]>>;
    try {
      due = await this.store.findWithDueObligations(now);
    } catch (err) {
      console.error("[executor] findWithDueObligations failed:", err);
      return;
    }

    for (const { contractId, stored } of due) {
      try {
        await this.processContract(contractId, stored, now);
      } catch (err) {
        console.error(`[executor] failed processing ${contractId}:`, err);
      }
    }
  }

  private async processContract(
    contractId: string,
    stored: StoredContract,
    now: Date,
  ): Promise<void> {
    const reg = this.registry.get(stored.contractType);
    if (!reg) return;

    const dueObligations = stored.state.obligations.filter(
      (o): o is Obligation & { deadline: string } =>
        o.status === "pending" &&
        o.deadline !== undefined &&
        new Date(o.deadline) <= now,
    );
    if (dueObligations.length === 0) return;

    let state = stored.state;

    for (const obligation of dueObligations) {
      const prevStatus = obligation.status;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx: any = { data: stored.data, state, now };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response: ContractResponse<any> =
        reg.logic.onObligationDue
          ? reg.logic.onObligationDue(obligation, ctx)
          : reg.logic.execute(
              {
                $class: `${stored.contractType}.OBLIGATION_DUE`,
                eventId: crypto.randomUUID(),
                timestamp: now.toISOString(),
                party: obligation.party,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                type: "OBLIGATION_DUE" as any,
                payload: {
                  obligationId: obligation.obligationId,
                  action: obligation.action,
                },
              },
              ctx,
            );

      const newStatus =
        response.state.obligations.find(
          (o) => o.obligationId === obligation.obligationId,
        )?.status ?? "pending";

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
