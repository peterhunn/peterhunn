import type { AgreementRecord, Webhook, WebhookEventType, WebhookPayload } from "./types.js";
import type { WebhookStore } from "./store.js";

/** Sign a webhook payload body with HMAC-SHA256. Returns "sha256=<hex>". */
export async function signWebhookPayload(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

/**
 * Deliver a webhook event to all active subscribers.
 *
 * Fire-and-forget per endpoint: failures are logged but never propagate to
 * the caller. Each delivery gets a 10 s timeout.
 *
 * For high-volume production use, replace with a queue-backed worker.
 */
export async function deliverWebhookEvent(
  store: WebhookStore,
  tenantId: string,
  type: WebhookEventType,
  agreement: AgreementRecord,
): Promise<void> {
  const hooks = await store.listActiveForEvent(tenantId, type);
  if (hooks.length === 0) return;

  const { token: _stripped, ...data } = agreement;
  const payload: WebhookPayload = {
    eventId: crypto.randomUUID(),
    type,
    createdAt: Math.floor(Date.now() / 1000),
    tenantId,
    data,
  };
  const body = JSON.stringify(payload);

  // Deliver to all hooks concurrently; don't await — callers shouldn't block.
  void Promise.all(hooks.map((hook) => deliverToHook(hook, body)));
}

async function deliverToHook(hook: Webhook, body: string): Promise<void> {
  try {
    const signature = await signWebhookPayload(hook.secret, body);
    const res = await fetch(hook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-X490-Signature": signature,
        "X-X490-Event": body.includes('"type"') ? (JSON.parse(body) as { type: string }).type : "unknown",
        "X-X490-Delivery": crypto.randomUUID(),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`Webhook delivery failed: ${hook.webhookId} → ${hook.url} (${res.status})`);
    }
  } catch (err) {
    console.error(`Webhook delivery error: ${hook.webhookId} → ${hook.url}`, err);
  }
}
