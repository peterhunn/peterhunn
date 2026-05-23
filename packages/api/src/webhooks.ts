import { promises as dns } from "node:dns";
import { isIP } from "node:net";

export type WebhookEventType =
  | "contract.activated"
  | "contract.event.processed"
  | "contract.status.changed"
  | "obligation.status.changed";

export interface Webhook {
  id: string;
  orgId: string;
  url: string;
  /** HMAC-SHA256 secret — shown once on creation, used to sign every delivery. */
  secret: string;
  events: WebhookEventType[];
  active: boolean;
  createdAt: Date;
}

export interface WebhookStore {
  create(
    orgId: string,
    url: string,
    events: WebhookEventType[],
  ): Promise<Webhook>;
  list(orgId: string): Promise<Webhook[]>;
  getById(id: string): Promise<Webhook | undefined>;
  disable(id: string): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  orgId: string;
  event: WebhookEventType;
  statusCode?: number;
  error?: string;
  attemptCount: number;
  succeededAt?: Date;
  createdAt: Date;
}

export interface WebhookDeliveryStore {
  record(delivery: WebhookDelivery): Promise<void>;
  markSuccess(id: string, statusCode: number): Promise<void>;
  markFailure(id: string, error: string, attemptCount: number): Promise<void>;
  listByWebhook(webhookId: string, limit?: number): Promise<WebhookDelivery[]>;
}

export class InMemoryWebhookStore implements WebhookStore {
  private readonly hooks = new Map<string, Webhook>();

  async create(
    orgId: string,
    url: string,
    events: WebhookEventType[],
  ): Promise<Webhook> {
    const hook: Webhook = {
      id: crypto.randomUUID(),
      orgId,
      url,
      secret: generateWebhookSecret(),
      events,
      active: true,
      createdAt: new Date(),
    };
    this.hooks.set(hook.id, hook);
    return hook;
  }

  async list(orgId: string): Promise<Webhook[]> {
    return [...this.hooks.values()].filter((h) => h.orgId === orgId);
  }

  async getById(id: string): Promise<Webhook | undefined> {
    return this.hooks.get(id);
  }

  async disable(id: string): Promise<void> {
    const h = this.hooks.get(id);
    if (h) this.hooks.set(id, { ...h, active: false });
  }

  async delete(id: string): Promise<void> {
    this.hooks.delete(id);
  }
}

export class InMemoryWebhookDeliveryStore implements WebhookDeliveryStore {
  private readonly deliveries = new Map<string, WebhookDelivery>();

  async record(delivery: WebhookDelivery): Promise<void> {
    this.deliveries.set(delivery.id, { ...delivery });
  }

  async markSuccess(id: string, statusCode: number): Promise<void> {
    const d = this.deliveries.get(id);
    if (d) this.deliveries.set(id, { ...d, statusCode, succeededAt: new Date() });
  }

  async markFailure(id: string, error: string, attemptCount: number): Promise<void> {
    const d = this.deliveries.get(id);
    if (d) this.deliveries.set(id, { ...d, error, attemptCount });
  }

  async listByWebhook(webhookId: string, limit = 50): Promise<WebhookDelivery[]> {
    return [...this.deliveries.values()]
      .filter((d) => d.webhookId === webhookId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }
}

function generateWebhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signPayload(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── SSRF protection ──────────────────────────────────────────────────────────

function isPrivateIpv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number) as [number, number, number, number];
  return (
    a === 127 ||
    a === 10 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
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
 * Throws if the URL resolves to a private/loopback address.
 * Called at registration time and again at delivery time (DNS rebinding defense).
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

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const version = isIP(hostname);

  if (version === 4) {
    if (isPrivateIpv4(hostname)) throw new Error(`Webhook URL targets a private address: ${hostname}`);
    return;
  }
  if (version === 6) {
    if (isPrivateIpv6(hostname)) throw new Error(`Webhook URL targets a private address: ${hostname}`);
    return;
  }

  const addresses: string[] = [];
  try { addresses.push(...(await dns.resolve4(hostname))); } catch { /* no A records */ }
  try { addresses.push(...(await dns.resolve6(hostname))); } catch { /* no AAAA records */ }

  if (addresses.length === 0) {
    throw new Error(`Webhook URL hostname did not resolve: ${hostname}`);
  }
  for (const addr of addresses) {
    if (isPrivateIpv4(addr) || isPrivateIpv6(addr)) {
      throw new Error(`Webhook URL resolves to a private address: ${addr} (${hostname})`);
    }
  }
}

// ── Delivery ─────────────────────────────────────────────────────────────────

/**
 * Deliver a single webhook event with up to 3 attempts (0 s, +2 s, +4 s backoff).
 * Throws after all attempts are exhausted.
 */
export async function deliverWebhook(
  webhook: Webhook,
  event: WebhookEventType,
  data: Record<string, unknown>,
  deliveries?: WebhookDeliveryStore,
): Promise<void> {
  // Defense-in-depth: re-check SSRF at delivery time to guard against DNS rebinding.
  await assertSafeWebhookUrl(webhook.url);

  const deliveryId = crypto.randomUUID();
  const payload = { id: deliveryId, event, data, timestamp: Date.now() };
  const body = JSON.stringify(payload);
  const sig = await signPayload(webhook.secret, body);

  if (deliveries) {
    await deliveries.record({
      id: deliveryId,
      webhookId: webhook.id,
      orgId: webhook.orgId,
      event,
      attemptCount: 1,
      createdAt: new Date(),
    });
  }

  const attempt = async (): Promise<number> => {
    const res = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Legal-Agents-Signature": `sha256=${sig}`,
        "X-Legal-Agents-Event": event,
        "X-Legal-Agents-Delivery": deliveryId,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${webhook.url}`);
    return res.status;
  };

  const backoff = [0, 2_000, 4_000];
  let lastError = "";
  for (let i = 0; i < backoff.length; i++) {
    if (backoff[i]! > 0) await new Promise((r) => setTimeout(r, backoff[i]));
    try {
      const statusCode = await attempt();
      if (deliveries) await deliveries.markSuccess(deliveryId, statusCode);
      return;
    } catch (err) {
      lastError = String(err);
    }
  }

  if (deliveries) await deliveries.markFailure(deliveryId, lastError, backoff.length);
  throw new Error(lastError);
}

/**
 * Fan out an event to all active, subscribed webhooks for an org.
 * Failures are logged but never surface to the caller — delivery is
 * fire-and-forget at the HTTP layer.
 */
export async function fanOut(
  store: WebhookStore,
  orgId: string,
  event: WebhookEventType,
  data: Record<string, unknown>,
  deliveries?: WebhookDeliveryStore,
): Promise<void> {
  const hooks = await store.list(orgId);
  const eligible = hooks.filter((h) => h.active && h.events.includes(event));
  await Promise.allSettled(
    eligible.map((h) =>
      deliverWebhook(h, event, data, deliveries).catch((err) =>
        console.error(`Webhook delivery failed [${h.id} → ${h.url}]:`, err),
      ),
    ),
  );
}
