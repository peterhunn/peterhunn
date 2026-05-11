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

/** Deliver a single webhook event. Throws on non-2xx or network error. */
export async function deliverWebhook(
  webhook: Webhook,
  event: WebhookEventType,
  data: Record<string, unknown>,
): Promise<void> {
  const payload = {
    id: crypto.randomUUID(),
    event,
    data,
    timestamp: Date.now(),
  };
  const body = JSON.stringify(payload);
  const sig = await signPayload(webhook.secret, body);

  const res = await fetch(webhook.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Legal-Agents-Signature": `sha256=${sig}`,
      "X-Legal-Agents-Event": event,
      "X-Legal-Agents-Delivery": payload.id,
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${webhook.url}`);
  }
}

/**
 * Fan out an event to all active, subscribed webhooks for an org.
 * Failures are logged but never surface to the caller — delivery is
 * fire-and-forget at the HTTP layer. Persistent retry lives in the
 * Postgres implementation via the webhook_deliveries table.
 */
export async function fanOut(
  store: WebhookStore,
  orgId: string,
  event: WebhookEventType,
  data: Record<string, unknown>,
): Promise<void> {
  const hooks = await store.list(orgId);
  const eligible = hooks.filter((h) => h.active && h.events.includes(event));
  await Promise.allSettled(
    eligible.map((h) =>
      deliverWebhook(h, event, data).catch((err) =>
        console.error(`Webhook delivery failed [${h.id} → ${h.url}]:`, err),
      ),
    ),
  );
}
