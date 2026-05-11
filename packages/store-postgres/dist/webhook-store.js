function rowToWebhook(r) {
    return {
        id: r.id,
        orgId: r.org_id,
        url: r.url,
        secret: r.secret,
        events: r.events,
        active: r.active,
        createdAt: r.created_at,
    };
}
function generateSecret() {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export class PostgresWebhookStore {
    sql;
    constructor(sql) {
        this.sql = sql;
    }
    async create(orgId, url, events) {
        const secret = generateSecret();
        const rows = await this.sql `
      INSERT INTO webhooks (org_id, url, secret, events)
      VALUES (${orgId}, ${url}, ${secret}, ${this.sql.array(events)})
      RETURNING *
    `;
        return rowToWebhook(rows[0]);
    }
    async list(orgId) {
        const rows = await this.sql `
      SELECT * FROM webhooks WHERE org_id = ${orgId} ORDER BY created_at DESC
    `;
        return rows.map(rowToWebhook);
    }
    async getById(id) {
        const rows = await this.sql `
      SELECT * FROM webhooks WHERE id = ${id}
    `;
        return rows[0] ? rowToWebhook(rows[0]) : undefined;
    }
    async disable(id) {
        await this.sql `UPDATE webhooks SET active = false WHERE id = ${id}`;
    }
    async delete(id) {
        await this.sql `DELETE FROM webhooks WHERE id = ${id}`;
    }
}
//# sourceMappingURL=webhook-store.js.map