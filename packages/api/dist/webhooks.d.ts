export type WebhookEventType = "contract.activated" | "contract.event.processed" | "contract.status.changed" | "obligation.status.changed";
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
    create(orgId: string, url: string, events: WebhookEventType[]): Promise<Webhook>;
    list(orgId: string): Promise<Webhook[]>;
    getById(id: string): Promise<Webhook | undefined>;
    disable(id: string): Promise<void>;
    delete(id: string): Promise<void>;
}
export declare class InMemoryWebhookStore implements WebhookStore {
    private readonly hooks;
    create(orgId: string, url: string, events: WebhookEventType[]): Promise<Webhook>;
    list(orgId: string): Promise<Webhook[]>;
    getById(id: string): Promise<Webhook | undefined>;
    disable(id: string): Promise<void>;
    delete(id: string): Promise<void>;
}
/** Deliver a single webhook event. Throws on non-2xx or network error. */
export declare function deliverWebhook(webhook: Webhook, event: WebhookEventType, data: Record<string, unknown>): Promise<void>;
/**
 * Fan out an event to all active, subscribed webhooks for an org.
 * Failures are logged but never surface to the caller — delivery is
 * fire-and-forget at the HTTP layer. Persistent retry lives in the
 * Postgres implementation via the webhook_deliveries table.
 */
export declare function fanOut(store: WebhookStore, orgId: string, event: WebhookEventType, data: Record<string, unknown>): Promise<void>;
//# sourceMappingURL=webhooks.d.ts.map