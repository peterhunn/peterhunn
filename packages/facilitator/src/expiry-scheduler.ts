/**
 * ExpiryScheduler — polls for agreements approaching their expiry date and
 * fires `contract.expiring` webhook events so operators can prompt renewal.
 *
 * Usage:
 *   const scheduler = new ExpiryScheduler({ agreements, webhooks, ... });
 *   scheduler.start();
 *   // on shutdown:
 *   scheduler.stop();
 */

import type { AgreementStore, WebhookStore, WebhookDeliveryStore } from "./store.js";
import type { WebhookPayload } from "./types.js";

export interface ExpirySchedulerOptions {
  agreements: AgreementStore;
  webhooks: WebhookStore;
  deliveries?: WebhookDeliveryStore;
  /**
   * How many seconds before expiry to send the warning.
   * Defaults to 7 days (604800 s).
   */
  warningWindowSeconds?: number;
  /** Poll interval in milliseconds. Defaults to 1 hour (3_600_000 ms). */
  intervalMs?: number;
  /** Injected for testing. */
  now?: () => number;
  /** Injected for testing — sends a single webhook payload. */
  deliver?: (url: string, secret: string, payload: WebhookPayload) => Promise<{ status: number }>;
}

export class ExpiryScheduler {
  private readonly agreements: AgreementStore;
  private readonly webhooks: WebhookStore;
  private readonly deliveries: WebhookDeliveryStore | undefined;
  private readonly warningWindow: number;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly deliver: (url: string, secret: string, payload: WebhookPayload) => Promise<{ status: number }>;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: ExpirySchedulerOptions) {
    this.agreements = opts.agreements;
    this.webhooks = opts.webhooks;
    this.deliveries = opts.deliveries;
    this.warningWindow = opts.warningWindowSeconds ?? 7 * 24 * 60 * 60;
    this.intervalMs = opts.intervalMs ?? 60 * 60 * 1000;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.deliver = opts.deliver ?? defaultDeliver;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        console.error("[ExpiryScheduler] tick error:", err);
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Exposed for testing — runs one check cycle. */
  async tick(): Promise<void> {
    const nowUnix = this.now();
    const windowEnd = nowUnix + this.warningWindow;

    const expiring = await this.agreements.findExpiringBetween(nowUnix, windowEnd);
    if (expiring.length === 0) return;

    for (const agreement of expiring) {
      const hooks = await this.webhooks.listActiveForEvent(agreement.tenantId, "contract.expiring");
      for (const hook of hooks) {
        const payload: WebhookPayload = {
          eventId: crypto.randomUUID(),
          type: "contract.expiring",
          createdAt: nowUnix,
          tenantId: agreement.tenantId,
          data: {
            contractId: agreement.contractId,
            tenantId: agreement.tenantId,
            templateHash: agreement.templateHash,
            partyId: agreement.partyId,
            resource: agreement.resource,
            partyData: agreement.partyData,
            issuedAt: agreement.issuedAt,
            expiresAt: agreement.expiresAt,
            ...(agreement.revokedAt !== undefined ? { revokedAt: agreement.revokedAt } : {}),
            ...(agreement.revokedReason !== undefined ? { revokedReason: agreement.revokedReason } : {}),
            ...(agreement.walletAddress !== undefined ? { walletAddress: agreement.walletAddress } : {}),
            ...(agreement.eip712Credential !== undefined ? { eip712Credential: agreement.eip712Credential } : {}),
            ...(agreement.nftTokenId !== undefined ? { nftTokenId: agreement.nftTokenId } : {}),
            ...(agreement.nftTxHash !== undefined ? { nftTxHash: agreement.nftTxHash } : {}),
            ...(agreement.externalSource !== undefined ? { externalSource: agreement.externalSource } : {}),
            ...(agreement.externalId !== undefined ? { externalId: agreement.externalId } : {}),
            ...(agreement.parentContractId !== undefined ? { parentContractId: agreement.parentContractId } : {}),
          },
        };

        try {
          const { status } = await this.deliver(hook.url, hook.secret, payload);
          const ok = status >= 200 && status < 300;
          if (this.deliveries) {
            const delivery = {
              deliveryId: crypto.randomUUID(),
              webhookId: hook.webhookId,
              tenantId: hook.tenantId,
              eventType: "contract.expiring" as const,
              contractId: agreement.contractId,
              statusCode: status,
              attemptCount: 1,
              createdAt: nowUnix,
              ...(ok ? { succeededAt: nowUnix } : {}),
            };
            await this.deliveries.record(delivery);
            if (ok) {
              await this.deliveries.markSuccess(delivery.deliveryId, status);
            }
          }
          if (ok) {
            await this.agreements.markWarned(agreement.contractId);
          }
        } catch (err) {
          console.error(`[ExpiryScheduler] delivery failed for webhook ${hook.webhookId}:`, err);
        }
      }
    }
  }
}

async function defaultDeliver(
  url: string,
  secret: string,
  payload: WebhookPayload,
): Promise<{ status: number }> {
  const body = JSON.stringify(payload);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-490-Signature": `sha256=${hex}`,
    },
    body,
  });
  return { status: res.status };
}
