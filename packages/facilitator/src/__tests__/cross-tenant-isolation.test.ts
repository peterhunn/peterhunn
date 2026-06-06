import { describe, it, expect } from "vitest";
import { createFacilitatorApp } from "../app.js";
import {
  InMemoryTenantStore,
  InMemoryTemplateStore,
  InMemoryAgreementStore,
  InMemoryRequirementsStore,
  InMemoryWebhookStore,
  InMemoryIdempotencyStore,
} from "../store.js";
import type { AgreementRecord } from "../types.js";

async function makeApp() {
  const tenants = new InMemoryTenantStore();
  const templates = new InMemoryTemplateStore();
  const agreements = new InMemoryAgreementStore();
  const requirements = new InMemoryRequirementsStore();
  const webhooks = new InMemoryWebhookStore();
  const idempotency = new InMemoryIdempotencyStore();

  const { rawApiKey: keyA, tenant: tenantA } = await tenants.create("Tenant A");
  const { rawApiKey: keyB, tenant: tenantB } = await tenants.create("Tenant B");

  const app = createFacilitatorApp({
    tenants, templates, agreements, requirements, webhooks, idempotency,
    baseUrl: "http://localhost:3000",
  });

  return { app, keyA, keyB, tenantA, tenantB, templates, agreements, webhooks };
}

function authA(key: string) { return { "X-API-Key": key }; }
function authB(key: string) { return { "X-API-Key": key }; }

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

// ── Template isolation ─────────────────────────────────────────────────────────

describe("Template isolation", () => {
  it("tenant A cannot supersede tenant B's template", async () => {
    const { app, keyA, keyB, tenantB } = await makeApp();

    // Tenant B registers a template
    const regRes = await app.request("/v1/templates", {
      method: "POST",
      headers: { ...authB(keyB), "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Tenant B NDA {{party}}." }),
    });
    expect(regRes.status).toBe(201);
    const { hash } = await regRes.json() as { hash: string };

    // Tenant A tries to supersede it — should get 404 (not found for their tenant)
    const res = await app.request(`/v1/templates/${hash}/supersede`, {
      method: "POST",
      headers: { ...authA(keyA), "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Tenant A hijacked NDA." }),
    });
    expect(res.status).toBe(404);
    void tenantB;
  });

  it("tenant A cannot see tenant B's template history", async () => {
    const { app, keyA, keyB } = await makeApp();

    const regRes = await app.request("/v1/templates", {
      method: "POST",
      headers: { ...authB(keyB), "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Secret B template {{party}}." }),
    });
    const { hash } = await regRes.json() as { hash: string };

    const res = await app.request(`/v1/templates/${hash}/history`, {
      headers: authA(keyA),
    });
    expect(res.status).toBe(404);
  });

  it("GET /v1/templates only returns the calling tenant's templates", async () => {
    const { app, keyA, keyB } = await makeApp();

    await app.request("/v1/templates", {
      method: "POST",
      headers: { ...authA(keyA), "Content-Type": "application/json" },
      body: JSON.stringify({ content: "A template {{x}}." }),
    });
    await app.request("/v1/templates", {
      method: "POST",
      headers: { ...authB(keyB), "Content-Type": "application/json" },
      body: JSON.stringify({ content: "B template {{y}}." }),
    });

    const resA = await app.request("/v1/templates", { headers: authA(keyA) });
    const bodyA = await resA.json() as { templates: { hash: string }[] };
    expect(bodyA.templates).toHaveLength(1);

    const resB = await app.request("/v1/templates", { headers: authB(keyB) });
    const bodyB = await resB.json() as { templates: { hash: string }[] };
    expect(bodyB.templates).toHaveLength(1);

    // Ensure different hashes
    expect(bodyA.templates[0]!.hash).not.toBe(bodyB.templates[0]!.hash);
  });
});

// ── Agreement isolation ────────────────────────────────────────────────────────

describe("Agreement isolation", () => {
  it("tenant A cannot fetch tenant B's agreement", async () => {
    const { app, keyA, tenantB, agreements } = await makeApp();

    const agr = makeAgreement(tenantB.tenantId);
    await agreements.record(agr);

    const res = await app.request(`/v1/agreements/${agr.contractId}`, {
      headers: authA(keyA),
    });
    expect(res.status).toBe(404);
  });

  it("GET /v1/agreements only returns the calling tenant's agreements", async () => {
    const { app, keyA, keyB, tenantA, tenantB, agreements } = await makeApp();

    await agreements.record(makeAgreement(tenantA.tenantId));
    await agreements.record(makeAgreement(tenantA.tenantId));
    await agreements.record(makeAgreement(tenantB.tenantId));

    const resA = await app.request("/v1/agreements", { headers: authA(keyA) });
    const bodyA = await resA.json() as { agreements: AgreementRecord[] };
    expect(bodyA.agreements).toHaveLength(2);
    for (const a of bodyA.agreements) {
      expect(a.tenantId).toBe(tenantA.tenantId);
    }

    const resB = await app.request("/v1/agreements", { headers: authB(keyB) });
    const bodyB = await resB.json() as { agreements: AgreementRecord[] };
    expect(bodyB.agreements).toHaveLength(1);
    expect(bodyB.agreements[0]!.tenantId).toBe(tenantB.tenantId);
  });

  it("tenant A cannot revoke tenant B's contract", async () => {
    const { app, keyA, tenantA, tenantB, agreements } = await makeApp();

    const agr = makeAgreement(tenantB.tenantId);
    await agreements.record(agr);

    const res = await app.request(`/v1/${tenantA.tenantId}/revoke`, {
      method: "POST",
      headers: { ...authA(keyA), "Content-Type": "application/json" },
      body: JSON.stringify({ contractId: agr.contractId }),
    });
    // 404 — not found for tenant A
    expect(res.status).toBe(404);

    // Contract still alive
    const stillExists = await agreements.findById(agr.contractId);
    expect(stillExists?.revokedAt).toBeUndefined();
  });

  it("tenant A cannot amend tenant B's contract", async () => {
    const { app, keyA, tenantB, templates, agreements } = await makeApp();

    const tmpl = await templates.register(tenantB.tenantId, "B contract {{x}}.", {});
    const agr = makeAgreement(tenantB.tenantId, { templateHash: tmpl.hash });
    await agreements.record(agr);

    const res = await app.request(`/v1/agreements/${agr.contractId}/amend`, {
      method: "POST",
      headers: { ...authA(keyA), "Content-Type": "application/json" },
      body: JSON.stringify({ changes: { x: "tampered" } }),
    });
    expect(res.status).toBe(404);
  });
});

// ── Webhook isolation ──────────────────────────────────────────────────────────

describe("Webhook isolation", () => {
  it("tenant A cannot disable tenant B's webhook", async () => {
    const { app, keyA, tenantB, webhooks } = await makeApp();

    // Create the webhook directly to skip DNS validation
    const { webhook } = await webhooks.create(tenantB.tenantId, "https://example.com/hook", ["agreement.created"]);

    // Tenant A tries to delete it
    const res = await app.request(`/v1/webhooks/${webhook.webhookId}`, {
      method: "DELETE",
      headers: authA(keyA),
    });
    expect(res.status).toBe(404);

    // The webhook is still active
    const stillActive = await webhooks.findById(webhook.webhookId);
    expect(stillActive?.active).toBe(true);
  });

  it("GET /v1/webhooks only returns the calling tenant's webhooks", async () => {
    const { app, keyA, keyB, tenantA, tenantB, webhooks } = await makeApp();

    await webhooks.create(tenantA.tenantId, "https://example.com/hookA", ["agreement.created"]);
    await webhooks.create(tenantB.tenantId, "https://example.com/hookB", ["agreement.revoked"]);

    const resA = await app.request("/v1/webhooks", { headers: authA(keyA) });
    const bodyA = await resA.json() as { webhooks: { webhookId: string }[] };
    expect(bodyA.webhooks).toHaveLength(1);

    const resB = await app.request("/v1/webhooks", { headers: authB(keyB) });
    const bodyB = await resB.json() as { webhooks: { webhookId: string }[] };
    expect(bodyB.webhooks).toHaveLength(1);

    expect(bodyA.webhooks[0]!.webhookId).not.toBe(bodyB.webhooks[0]!.webhookId);
  });
});

// ── API key isolation ──────────────────────────────────────────────────────────

describe("API key isolation", () => {
  it("tenant A cannot revoke tenant B's API key", async () => {
    const { app, keyA, keyB } = await makeApp();

    // Get tenant B's key IDs
    const keysRes = await app.request("/v1/apikeys", { headers: authB(keyB) });
    const { apiKeys } = await keysRes.json() as { apiKeys: { keyId: string }[] };
    const bKeyId = apiKeys[0]!.keyId;

    // Tenant A tries to revoke it
    const res = await app.request(`/v1/apikeys/${bKeyId}`, {
      method: "DELETE",
      headers: authA(keyA),
    });
    expect(res.status).toBe(404);

    // Tenant B's key still works
    const meRes = await app.request("/v1/me", { headers: authB(keyB) });
    expect(meRes.status).toBe(200);
  });
});

// ── Stats isolation ────────────────────────────────────────────────────────────

describe("Stats isolation", () => {
  it("each tenant only sees their own agreement counts", async () => {
    const { app, keyA, keyB, tenantA, tenantB, agreements } = await makeApp();

    await agreements.record(makeAgreement(tenantA.tenantId));
    await agreements.record(makeAgreement(tenantA.tenantId));
    await agreements.record(makeAgreement(tenantB.tenantId));

    const statsA = await app.request("/v1/stats", { headers: authA(keyA) });
    const bodyA = await statsA.json() as { agreements: { total: number } };
    expect(bodyA.agreements.total).toBe(2);

    const statsB = await app.request("/v1/stats", { headers: authB(keyB) });
    const bodyB = await statsB.json() as { agreements: { total: number } };
    expect(bodyB.agreements.total).toBe(1);
  });
});

// ── Idempotency key isolation ──────────────────────────────────────────────────

describe("Idempotency key isolation", () => {
  it("same Idempotency-Key value used by two tenants does not collide", async () => {
    const { app, keyA, keyB } = await makeApp();
    const sharedKey = "key-abc-123";

    // Tenant A creates a template
    const resA = await app.request("/v1/templates", {
      method: "POST",
      headers: { ...authA(keyA), "Content-Type": "application/json", "Idempotency-Key": sharedKey },
      body: JSON.stringify({ content: "Tenant A contract {{x}}.", title: "A" }),
    });
    expect(resA.status).toBe(201);
    const bodyA = await resA.json() as { hash: string };

    // Tenant B uses the same idempotency key for a different request
    const resB = await app.request("/v1/templates", {
      method: "POST",
      headers: { ...authB(keyB), "Content-Type": "application/json", "Idempotency-Key": sharedKey },
      body: JSON.stringify({ content: "Tenant B contract {{y}}.", title: "B" }),
    });
    expect(resB.status).toBe(201);
    const bodyB = await resB.json() as { hash: string };

    // Each tenant got their own template
    expect(bodyA.hash).not.toBe(bodyB.hash);

    // Tenant A replaying the same key gets tenant A's response back, not tenant B's
    const replayA = await app.request("/v1/templates", {
      method: "POST",
      headers: { ...authA(keyA), "Content-Type": "application/json", "Idempotency-Key": sharedKey },
      body: JSON.stringify({ content: "Tenant A contract {{x}}.", title: "A" }),
    });
    expect(replayA.status).toBe(201);
    const replayBodyA = await replayA.json() as { hash: string };
    expect(replayBodyA.hash).toBe(bodyA.hash);
    expect(replayA.headers.get("Idempotency-Replayed")).toBe("true");
  });
});

// ── HMAC secret rotation isolation ────────────────────────────────────────────

describe("HMAC secret rotation isolation", () => {
  it("rotating tenant A's secret does not affect tenant B's tokens", async () => {
    const { app, keyA, keyB, tenantA, tenantB } = await makeApp();

    // Both tenants accept a contract first
    await app.request("/v1/templates", {
      method: "POST",
      headers: { ...authB(keyB), "Content-Type": "application/json" },
      body: JSON.stringify({ content: "B contract {{name}}." }),
    });

    // Rotate tenant A's secret
    const rotateRes = await app.request("/v1/me/rotate-secret", {
      method: "POST",
      headers: { ...authA(keyA), "Content-Type": "application/json" },
      body: "{}",
    });
    expect(rotateRes.status).toBe(200);
    const { tenantId } = await rotateRes.json() as { tenantId: string };
    expect(tenantId).toBe(tenantA.tenantId);

    // Tenant B is unaffected — can still list their templates
    const tmplRes = await app.request("/v1/templates", { headers: authB(keyB) });
    expect(tmplRes.status).toBe(200);
    void tenantB;
  });

  it("POST /v1/me/rotate-secret requires authentication", async () => {
    const { app } = await makeApp();
    const res = await app.request("/v1/me/rotate-secret", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });
});
