/**
 * WebhookRetryWorker — polls for failed deliveries and re-attempts them
 * with exponential backoff up to maxAttempts.
 *
 * Backoff schedule (after the 3 in-process attempts in webhook.ts):
 *   attempt 4:  +2 min
 *   attempt 5:  +4 min
 *   attempt 6:  +8 min
 *   attempt 7:  +16 min
 *   attempt 8:  +32 min
 *   attempt 9:  +64 min (cap: 1 hour)
 *   attempt 10: +60 min (cap)
 *   attempt 11+: permanently failed
 */

import type { WebhookDeliveryStore, WebhookStore } from "./store.js";
import { signWebhookPayload } from "./webhook.js";
import { assertSafeWebhookUrl } from "./webhook.js";

export interface WebhookRetryWorkerOptions {
  deliveries: WebhookDeliveryStore;
  webhooks: WebhookStore;
  /** Max total attempts including in-process ones. Default 10. */
  maxAttempts?: number;
  /** Poll interval in ms. Default 5 minutes. */
  intervalMs?: number;
  /** Injected for testing. */
  now?: () => number;
}

export class WebhookRetryWorker {
  private readonly deliveries: WebhookDeliveryStore;
  private readonly webhooks: WebhookStore;
  private readonly maxAttempts: number;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: WebhookRetryWorkerOptions) {
    this.deliveries = opts.deliveries;
    this.webhooks = opts.webhooks;
    this.maxAttempts = opts.maxAttempts ?? 10;
    this.intervalMs = opts.intervalMs ?? 5 * 60 * 1000;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => console.error("[WebhookRetryWorker] tick error:", err));
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
  }

  async tick(): Promise<void> {
    const nowUnix = this.now();
    const pending = await this.deliveries.listPendingRetries(nowUnix, 100);

    for (const delivery of pending) {
      if (!delivery.payload) continue; // can't retry without payload

      const hook = await this.webhooks.findById(delivery.webhookId);
      if (!hook || !hook.active) {
        await this.deliveries.permanentlyFail(delivery.deliveryId, "Webhook disabled or not found");
        continue;
      }

      try {
        await assertSafeWebhookUrl(hook.url);
      } catch (err) {
        await this.deliveries.permanentlyFail(delivery.deliveryId, `SSRF: ${(err as Error).message}`);
        continue;
      }

      const newAttemptCount = delivery.attemptCount + 1;

      try {
        const signature = await signWebhookPayload(hook.secret, delivery.payload);
        const res = await fetch(hook.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-X490-Signature": signature,
            "X-X490-Event": delivery.eventType,
            "X-X490-Delivery": delivery.deliveryId,
          },
          body: delivery.payload,
          signal: AbortSignal.timeout(10_000),
        });

        if (res.ok) {
          await this.deliveries.markSuccess(delivery.deliveryId, res.status);
        } else if (newAttemptCount >= this.maxAttempts) {
          await this.deliveries.permanentlyFail(delivery.deliveryId, `HTTP ${res.status} after ${newAttemptCount} attempts`);
        } else {
          const nextRetryAt = nowUnix + this.backoffSeconds(newAttemptCount);
          await this.deliveries.scheduleRetry(delivery.deliveryId, nextRetryAt, newAttemptCount);
        }
      } catch (err) {
        if (newAttemptCount >= this.maxAttempts) {
          await this.deliveries.permanentlyFail(delivery.deliveryId, `${err} after ${newAttemptCount} attempts`);
        } else {
          const nextRetryAt = nowUnix + this.backoffSeconds(newAttemptCount);
          await this.deliveries.scheduleRetry(delivery.deliveryId, nextRetryAt, newAttemptCount);
        }
      }
    }
  }

  /** Exponential backoff capped at 1 hour. Attempt 4 = 120s, 5 = 240s, ..., 9+ = 3600s. */
  private backoffSeconds(attemptCount: number): number {
    return Math.min(120 * Math.pow(2, attemptCount - 4), 3600);
  }
}
