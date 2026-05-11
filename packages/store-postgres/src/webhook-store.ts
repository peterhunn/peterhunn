import type postgres from "postgres";
import type { WebhookStore, Webhook, WebhookEventType } from "@legal-agents/api";

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
