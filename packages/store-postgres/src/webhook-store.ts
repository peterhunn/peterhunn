import type postgres from "postgres";
import type {
  WebhookStore,
  Webhook,
  WebhookEventType,
  WebhookDeliveryStore,
  WebhookDelivery,
} from "@x490/api";

type Sql = ReturnType<typeof postgres>;

interface WebhookRow {
  id: string;
  org_id: string;
  url: string;
  secret: string;
  events: string[];
  active: boolean;
  created_at: Date;
}

function rowToWebhook(r: WebhookRow): Webhook {
  return {
    id: r.id,
    orgId: r.org_id,
    url: r.url,
    secret: r.secret,
    events: r.events as WebhookEventType[],
    active: r.active,
    createdAt: r.created_at,
  };
}

function generateSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class PostgresWebhookStore implements WebhookStore {
  constructor(private readonly sql: Sql) {}

  async create(
    orgId: string,
    url: string,
    events: WebhookEventType[],
  ): Promise<Webhook> {
    const secret = generateSecret();
    const rows = await this.sql<WebhookRow[]>`
      INSERT INTO webhooks (org_id, url, secret, events)
      VALUES (${orgId}, ${url}, ${secret}, ${this.sql.array(events)})
      RETURNING *
    `;
    return rowToWebhook(rows[0]!);
  }

  async list(orgId: string): Promise<Webhook[]> {
    const rows = await this.sql<WebhookRow[]>`
      SELECT * FROM webhooks WHERE org_id = ${orgId} ORDER BY created_at DESC
    `;
    return rows.map(rowToWebhook);
  }

  async getById(id: string): Promise<Webhook | undefined> {
    const rows = await this.sql<WebhookRow[]>`
      SELECT * FROM webhooks WHERE id = ${id}
    `;
    return rows[0] ? rowToWebhook(rows[0]) : undefined;
  }

  async disable(id: string): Promise<void> {
    await this.sql`UPDATE webhooks SET active = false WHERE id = ${id}`;
  }

  async delete(id: string): Promise<void> {
    await this.sql`DELETE FROM webhooks WHERE id = ${id}`;
  }
}

interface DeliveryRow {
  id: string;
  webhook_id: string;
  org_id: string;
  event_type: string;
  status_code: number | null;
  error: string | null;
  attempt_count: number;
  succeeded_at: Date | null;
  created_at: Date;
}

function rowToDelivery(r: DeliveryRow): WebhookDelivery {
  return {
    id: r.id,
    webhookId: r.webhook_id,
    orgId: r.org_id,
    event: r.event_type as WebhookEventType,
    ...(r.status_code != null ? { statusCode: r.status_code } : {}),
    ...(r.error != null ? { error: r.error } : {}),
    attemptCount: r.attempt_count,
    ...(r.succeeded_at != null ? { succeededAt: r.succeeded_at } : {}),
    createdAt: r.created_at,
  };
}

export class PostgresWebhookDeliveryStore implements WebhookDeliveryStore {
  constructor(private readonly sql: Sql) {}

  async record(delivery: WebhookDelivery): Promise<void> {
    await this.sql`
      INSERT INTO webhook_deliveries
        (id, webhook_id, org_id, event_type, attempt_count, created_at)
      VALUES
        (${delivery.id}, ${delivery.webhookId}, ${delivery.orgId},
         ${delivery.event}, ${delivery.attemptCount}, ${delivery.createdAt})
    `;
  }

  async markSuccess(id: string, statusCode: number): Promise<void> {
    await this.sql`
      UPDATE webhook_deliveries
      SET status_code = ${statusCode}, succeeded_at = now()
      WHERE id = ${id}
    `;
  }

  async markFailure(id: string, error: string, attemptCount: number): Promise<void> {
    await this.sql`
      UPDATE webhook_deliveries
      SET error = ${error}, attempt_count = ${attemptCount}
      WHERE id = ${id}
    `;
  }

  async listByWebhook(webhookId: string, limit = 50): Promise<WebhookDelivery[]> {
    const rows = await this.sql<DeliveryRow[]>`
      SELECT * FROM webhook_deliveries
      WHERE webhook_id = ${webhookId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows.map(rowToDelivery);
  }
}
