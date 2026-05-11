import type postgres from "postgres";
import type { WebhookStore, Webhook, WebhookEventType } from "@legal-agents/api";
type Sql = ReturnType<typeof postgres>;
export declare class PostgresWebhookStore implements WebhookStore {
    private readonly sql;
    constructor(sql: Sql);
    create(orgId: string, url: string, events: WebhookEventType[]): Promise<Webhook>;
    list(orgId: string): Promise<Webhook[]>;
    getById(id: string): Promise<Webhook | undefined>;
    disable(id: string): Promise<void>;
    delete(id: string): Promise<void>;
}
export {};
//# sourceMappingURL=webhook-store.d.ts.map