import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import type { AgreementRecord, Webhook, WebhookEventType, WebhookPayload } from "./types.js";
import type { WebhookStore, WebhookDeliveryStore } from "./store.js";

// ── SSRF protection ────────────────────────────────────────────────────────────

function isPrivateIpv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number) as [number, number, number, number];
  return (
    a === 127 ||
    a === 10 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) // link-local
  );
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return (
    lower === "::1" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe80")
  );
}

/**
 * Throw if `url` resolves to a private/loopback address.
 *
 * Called both at registration time (fast UX feedback) and at delivery time
 * (guards against DNS rebinding attacks).
 */
export async function assertSafeWebhookUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid webhook URL: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Webhook URL must use http or https: ${url}`);
  }

  // Strip brackets from IPv6 literals like [::1]
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");

  const version = isIP(hostname);
  if (version === 4) {
    if (isPrivateIpv4(hostname)) {
      throw new Error(`Webhook URL targets a private address: ${hostname}`);
    }
    return;
  }
  if (version === 6) {
    if (isPrivateIpv6(hostname)) {
      throw new Error(`Webhook URL targets a private address: ${hostname}`);
    }
    return;
  }

  // Hostname — resolve DNS and check every returned address
  const addresses: string[] = [];
  try {
    addresses.push(...(await dns.resolve4(hostname)));
  } catch { /* hostname may not have A records */ }
  try {
    addresses.push(...(await dns.resolve6(hostname)));
  } catch { /* hostname may not have AAAA records */ }

  if (addresses.length === 0) {
    throw new Error(`Webhook URL hostname did not resolve: ${hostname}`);
  }
  for (const addr of addresses) {
    if (isPrivateIpv4(addr) || isPrivateIpv6(addr)) {
      throw new Error(`Webhook URL resolves to a private address: ${addr} (${hostname})`);
    }
  }
}

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
 * the caller. Each delivery gets a 10 s timeout. Failed deliveries are retried
 * twice (after 2 s, then 4 s) before being marked as failed.
 *
 * For high-volume production use, replace with a queue-backed worker.
 */
export async function deliverWebhookEvent(
  store: WebhookStore,
  tenantId: string,
  type: WebhookEventType,
  agreement: AgreementRecord,
  deliveries?: WebhookDeliveryStore,
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
  void Promise.all(hooks.map((hook) => deliverToHook(hook, body, agreement.contractId, deliveries)));
}

async function deliverToHook(
  hook: Webhook,
  body: string,
  contractId: string | undefined,
  deliveries?: WebhookDeliveryStore,
): Promise<void> {
  try {
    await assertSafeWebhookUrl(hook.url);
  } catch (err) {
    console.error(`Webhook delivery blocked (SSRF): ${hook.webhookId} → ${hook.url}`, err);
    return;
  }

  const deliveryId = crypto.randomUUID();
  const parsedPayload = JSON.parse(body) as { type?: string };
  const eventType = parsedPayload.type ?? "unknown";

  // Record the delivery attempt before the first try.
  if (deliveries) {
    await deliveries.record({
      deliveryId,
      webhookId: hook.webhookId,
      tenantId: hook.tenantId,
      eventType,
      ...(contractId ? { contractId } : {}),
      attemptCount: 1,
      createdAt: Math.floor(Date.now() / 1000),
      payload: body,
    });
  }

  const attemptDelivery = async (): Promise<{ ok: boolean; status?: number; error?: string }> => {
    try {
      const signature = await signWebhookPayload(hook.secret, body);
      const res = await fetch(hook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-X490-Signature": signature,
          "X-X490-Event": eventType,
          "X-X490-Delivery": deliveryId,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { ok: true, status: res.status };
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  };

  // First attempt
  let result = await attemptDelivery();
  if (result.ok) {
    if (deliveries) await deliveries.markSuccess(deliveryId, result.status!);
    return;
  }

  // Retry after 2 s
  await new Promise((r) => setTimeout(r, 2000));
  result = await attemptDelivery();
  if (result.ok) {
    if (deliveries) await deliveries.markSuccess(deliveryId, result.status!);
    return;
  }

  // Retry after 4 s
  await new Promise((r) => setTimeout(r, 4000));
  result = await attemptDelivery();
  if (result.ok) {
    if (deliveries) await deliveries.markSuccess(deliveryId, result.status!);
    return;
  }

  // All attempts exhausted — mark failure and schedule persistent retry
  const errMsg = result.error ?? "unknown error";
  console.error(`Webhook delivery failed after 3 attempts: ${hook.webhookId} → ${hook.url} (${errMsg})`);
  if (deliveries) {
    await deliveries.markFailure(deliveryId, errMsg, 3);
    // Schedule next retry attempt at +2 minutes (next step in exponential backoff)
    const nextRetryAt = Math.floor(Date.now() / 1000) + 120;
    await deliveries.scheduleRetry(deliveryId, nextRetryAt, 3);
  }
}
