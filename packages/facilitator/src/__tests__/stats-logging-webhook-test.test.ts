import { describe, it, expect, vi } from "vitest";
import { createFacilitatorApp } from "../app.js";
import {
  InMemoryTenantStore,
  InMemoryTemplateStore,
  InMemoryAgreementStore,
  InMemoryRequirementsStore,
  InMemoryWebhookStore,
} from "../store.js";
import type { AgreementRecord } from "../types.js";

async function makeApp(healthCheck?: () => Promise<Record<string, boolean>>) {
  const tenants = new InMemoryTenantStore();
  const templates = new InMemoryTemplateStore();
  const agreements = new InMemoryAgreementStore();
  const requirements = new InMemoryRequirementsStore();
  const webhooks = new InMemoryWebhookStore();
  const { rawApiKey, tenant } = await tenants.create("Acme");
  const app = createFacilitatorApp({
    tenants, templates, agreements, requirements, webhooks,
    baseUrl: "http://localhost:3000",
    ...(healthCheck ? { healthCheck } : {}),
  });
  return { app, rawApiKey, tenant, templates, agreements, webhooks };
}

function auth(rawApiKey: string) {
  return { "X-API-Key": rawApiKey };
}

function makeAgreement(tenantId: string, overrides: Partial<AgreementRecord> = {}): AgreementRecord {
  const nowUnix = Math.floor(Date.now() / 1000);
  return {
    contractId: `c-${Math.random().toString(36).slice(2)}`,
    tenantId,
    templateHash: "abc",
    partyId: "party-1",
    resource: "/api/tool",
    partyData: {},
    token: "tok",
    issuedAt: nowUnix - 3600,
    expiresAt: nowUnix + 3600,
    ...overrides,
  };
}

// ── Structured logging ────────────────────────────────────────────────────────

describe("Request logging middleware", () => {
  it("sets X-Request-ID header on every response", async () => {
    const { app, rawApiKey } = await makeApp();
    const res = await app.request("/v1/me", { headers: auth(rawApiKey) });
    expect(res.headers.get("X-Request-ID")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("sets X-Request-ID even on unauthenticated requests", async () => {
    const { app } = await makeApp();
    const res = await app.request("/health");
    expect(res.headers.get("X-Request-ID")).toBeTruthy();
  });
});

// ── Richer /v1/stats ──────────────────────────────────────────────────────────

describe("GET /v1/stats — richer response", () => {
  it("returns agreement, template and webhook counts", async () => {
    const { app, rawApiKey, tenant, templates, agreements, webhooks } = await makeApp();

    await templates.register(tenant.tenantId, "Pay {{amount}}.", {});
    await templates.register(tenant.tenantId, "NDA {{party}}.", {});

    const nowUnix = Math.floor(Date.now() / 1000);
    await agreements.record(makeAgreement(tenant.tenantId));
    await agreements.record(makeAgreement(tenant.tenantId, { revokedAt: nowUnix - 60 }));

    await webhooks.create(tenant.tenantId, "https://example.com/hook", ["agreement.created"]);

    const res = await app.request("/v1/stats", { headers: auth(rawApiKey) });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      agreements: { total: number; active: number; revoked: number; expiringIn7Days: number };
      templates: { total: number };
      webhooks: { total: number; active: number };
    };

    expect(body.agreements.total).toBe(2);
    expect(body.agreements.active).toBe(1);
    expect(body.agreements.revoked).toBe(1);
    expect(body.templates.total).toBe(2);
    expect(body.webhooks.total).toBe(1);
    expect(body.webhooks.active).toBe(1);
  });

  it("includes expiringIn7Days for agreements expiring within the window", async () => {
    const { app, rawApiKey, tenant, agreements } = await makeApp();
    const nowUnix = Math.floor(Date.now() / 1000);
    await agreements.record(makeAgreement(tenant.tenantId, { expiresAt: nowUnix + 3 * 86400 }));
    await agreements.record(makeAgreement(tenant.tenantId, { expiresAt: nowUnix + 30 * 86400 }));

    const res = await app.request("/v1/stats", { headers: auth(rawApiKey) });
    const body = await res.json() as { agreements: { expiringIn7Days: number } };
    expect(body.agreements.expiringIn7Days).toBe(1);
  });
});

// ── Webhook test endpoint ─────────────────────────────────────────────────────

describe("POST /v1/webhooks/:webhookId/test", () => {
  it("returns ok:true when endpoint responds 2xx", async () => {
    const { app, rawApiKey, tenant, webhooks } = await makeApp();
    const { webhook } = await webhooks.create(
      tenant.tenantId, "https://example.com/hook", ["agreement.created"],
    );

    const mockFetch = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);

    const res = await app.request(`/v1/webhooks/${webhook.webhookId}/test`, {
      method: "POST",
      headers: { ...auth(rawApiKey), "Content-Type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; statusCode: number };
    expect(body.ok).toBe(true);
    expect(body.statusCode).toBe(200);

    // Verify the synthetic payload was signed and sent
    expect(mockFetch).toHaveBeenCalledOnce();
    const [, init] = mockFetch.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({
      "X-X490-Signature": expect.stringMatching(/^sha256=/),
      "X-X490-Event": "agreement.created",
    });

    vi.unstubAllGlobals();
  });

  it("returns ok:false when endpoint returns non-2xx", async () => {
    const { app, rawApiKey, tenant, webhooks } = await makeApp();
    const { webhook } = await webhooks.create(
      tenant.tenantId, "https://example.com/hook", ["agreement.created"],
    );

    vi.stubGlobal("fetch", async () => new Response(null, { status: 503 }));

    const res = await app.request(`/v1/webhooks/${webhook.webhookId}/test`, {
      method: "POST",
      headers: { ...auth(rawApiKey), "Content-Type": "application/json" },
      body: "{}",
    });

    const body = await res.json() as { ok: boolean; statusCode: number };
    expect(body.ok).toBe(false);
    expect(body.statusCode).toBe(503);
    vi.unstubAllGlobals();
  });

  it("respects eventType override when it matches a subscribed event", async () => {
    const { app, rawApiKey, tenant, webhooks } = await makeApp();
    const { webhook } = await webhooks.create(
      tenant.tenantId, "https://example.com/hook", ["agreement.created", "agreement.revoked"],
    );

    const mockFetch = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);

    await app.request(`/v1/webhooks/${webhook.webhookId}/test`, {
      method: "POST",
      headers: { ...auth(rawApiKey), "Content-Type": "application/json" },
      body: JSON.stringify({ eventType: "agreement.revoked" }),
    });

    const [, init] = mockFetch.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({ "X-X490-Event": "agreement.revoked" });
    vi.unstubAllGlobals();
  });

  it("returns 404 for unknown webhookId", async () => {
    const { app, rawApiKey } = await makeApp();
    const res = await app.request("/v1/webhooks/no-such-id/test", {
      method: "POST",
      headers: { ...auth(rawApiKey), "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 for a disabled webhook", async () => {
    const { app, rawApiKey, tenant, webhooks } = await makeApp();
    const { webhook } = await webhooks.create(
      tenant.tenantId, "https://example.com/hook", ["agreement.created"],
    );
    await webhooks.disable(webhook.webhookId);

    const res = await app.request(`/v1/webhooks/${webhook.webhookId}/test`, {
      method: "POST",
      headers: { ...auth(rawApiKey), "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(409);
  });
});

// ── InMemoryTemplateStore.countByTenant ───────────────────────────────────────

describe("InMemoryTemplateStore.countByTenant", () => {
  it("counts only templates belonging to the tenant", async () => {
    const store = new InMemoryTemplateStore();
    await store.register("t1", "content A", {});
    await store.register("t1", "content B", {});
    await store.register("t2", "content C", {});
    expect(await store.countByTenant("t1")).toBe(2);
    expect(await store.countByTenant("t2")).toBe(1);
    expect(await store.countByTenant("t3")).toBe(0);
  });
});

// ── InMemoryAgreementStore.countByTenant ──────────────────────────────────────

describe("InMemoryAgreementStore.countByTenant", () => {
  it("returns total and active counts", async () => {
    const store = new InMemoryAgreementStore();
    const nowUnix = Math.floor(Date.now() / 1000);

    await store.record(makeAgreement("t1"));
    await store.record(makeAgreement("t1", { revokedAt: nowUnix - 60 }));
    await store.record(makeAgreement("t1"));
    await store.record(makeAgreement("t2"));

    const { total, active } = await store.countByTenant("t1");
    expect(total).toBe(3);
    expect(active).toBe(2);

    const t2 = await store.countByTenant("t2");
    expect(t2.total).toBe(1);
    expect(t2.active).toBe(1);
  });
});
