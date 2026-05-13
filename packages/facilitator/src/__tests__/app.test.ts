import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryTenantStore,
  InMemoryTemplateStore,
  InMemoryRequirementsStore,
  InMemoryAgreementStore,
  InMemoryWebhookStore,
} from "../store.js";
import { createFacilitatorApp } from "../app.js";

const BASE_URL = "https://facilitator.example.com";

function makeStores() {
  return {
    tenants: new InMemoryTenantStore(),
    templates: new InMemoryTemplateStore(),
    requirements: new InMemoryRequirementsStore(),
    agreements: new InMemoryAgreementStore(),
    webhooks: new InMemoryWebhookStore(),
  };
}

function makeApp(stores = makeStores()) {
  return {
    app: createFacilitatorApp({ ...stores, baseUrl: BASE_URL }),
    ...stores,
  };
}

async function signUp(app: ReturnType<typeof createFacilitatorApp>, name = "Test Tenant") {
  const res = await app.request("/v1/tenants", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return res.json() as Promise<{ tenantId: string; apiKey: string; keyId: string; note: string }>;
}

async function registerTemplate(
  app: ReturnType<typeof createFacilitatorApp>,
  apiKey: string,
  content = "This is an NDA template: {{name}}",
) {
  const res = await app.request("/v1/templates", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify({ content, title: "Test NDA", description: "A test NDA" }),
  });
  return res.json() as Promise<{ hash: string; url: string; title?: string; description?: string }>;
}

async function postRequirements(
  app: ReturnType<typeof createFacilitatorApp>,
  apiKey: string,
  templateHash: string,
  tenantId: string,
  opts: { expiresIn?: number } = {},
) {
  const res = await app.request("/v1/requirements", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify({
      templateHash,
      requiredPartyFields: ["name"],
      resource: "*",
      description: "Test requirements",
      expiresIn: opts.expiresIn ?? 3600,
    }),
  });
  return res;
}

async function acceptContract(
  app: ReturnType<typeof createFacilitatorApp>,
  tenantId: string,
  templateHash: string,
) {
  const res = await app.request(`/v1/${tenantId}/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      templateHash,
      partyData: { name: "Alice", partyId: "alice-001" },
    }),
  });
  return res.json() as Promise<{ status: string; contractId: string; token: string }>;
}

// ── POST /v1/tenants ───────────────────────────────────────────────────────────

describe("POST /v1/tenants", () => {
  it("201 — returns tenantId, apiKey, and keyId", async () => {
    const { app } = makeApp();
    const res = await app.request("/v1/tenants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Acme" }),
    });
    assert.strictEqual(res.status, 201);
    const body = await res.json() as { tenantId: string; apiKey: string; keyId: string };
    assert.ok(body.tenantId.length > 0);
    assert.ok(body.apiKey.startsWith("sk_x490_"));
    assert.ok(body.keyId.length > 0);
  });

  it("400 — missing name returns error", async () => {
    const { app } = makeApp();
    const res = await app.request("/v1/tenants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json() as { error: string };
    assert.ok(body.error.includes("name"));
  });

  it("400 — blank name returns error", async () => {
    const { app } = makeApp();
    const res = await app.request("/v1/tenants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    });
    assert.strictEqual(res.status, 400);
  });
});

// ── GET /v1/templates/:hash ────────────────────────────────────────────────────

describe("GET /v1/templates/:hash", () => {
  it("404 when template not found", async () => {
    const { app } = makeApp();
    const res = await app.request("/v1/templates/deadbeef");
    assert.strictEqual(res.status, 404);
  });

  it("200 with content after registration", async () => {
    const { app } = makeApp();
    const { apiKey } = await signUp(app);
    const { hash } = await registerTemplate(app, apiKey, "Some contract content");
    const res = await app.request(`/v1/templates/${hash}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json() as { hash: string; content: string; title?: string };
    assert.strictEqual(body.hash, hash);
    assert.strictEqual(body.content, "Some contract content");
    assert.strictEqual(body.title, "Test NDA");
  });
});

// ── POST /v1/templates ────────────────────────────────────────────────────────

describe("POST /v1/templates", () => {
  it("401 without API key", async () => {
    const { app } = makeApp();
    const res = await app.request("/v1/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Some content" }),
    });
    assert.strictEqual(res.status, 401);
  });

  it("400 missing content", async () => {
    const { app } = makeApp();
    const { apiKey } = await signUp(app);
    const res = await app.request("/v1/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ title: "No content here" }),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json() as { error: string };
    assert.ok(body.error.includes("content"));
  });

  it("201 success — returns hash and url", async () => {
    const { app } = makeApp();
    const { apiKey } = await signUp(app);
    const res = await app.request("/v1/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ content: "My NDA template.", title: "NDA", description: "An NDA" }),
    });
    assert.strictEqual(res.status, 201);
    const body = await res.json() as { hash: string; url: string };
    assert.ok(body.hash.length > 0);
    assert.ok(body.url.includes(body.hash));
    assert.ok(body.url.startsWith(BASE_URL));
  });
});

// ── POST /v1/requirements ─────────────────────────────────────────────────────

describe("POST /v1/requirements", () => {
  it("401 without API key", async () => {
    const { app } = makeApp();
    const res = await app.request("/v1/requirements", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateHash: "abc" }),
    });
    assert.strictEqual(res.status, 401);
  });

  it("404 unknown templateHash", async () => {
    const { app } = makeApp();
    const { apiKey } = await signUp(app);
    const res = await postRequirements(app, apiKey, "no-such-hash", "tid");
    assert.strictEqual(res.status, 404);
  });

  it("403 template belongs to a different tenant", async () => {
    const { app } = makeApp();
    const tenant1 = await signUp(app, "Tenant 1");
    const tenant2 = await signUp(app, "Tenant 2");
    // Tenant1 registers a template
    const { hash } = await registerTemplate(app, tenant1.apiKey);
    // Tenant2 tries to create requirements for it
    const res = await postRequirements(app, tenant2.apiKey, hash, tenant2.tenantId);
    assert.strictEqual(res.status, 403);
  });

  it("200 success — returns requirements object with correct endpoints", async () => {
    const { app } = makeApp();
    const { apiKey, tenantId } = await signUp(app);
    const { hash } = await registerTemplate(app, apiKey);
    const res = await postRequirements(app, apiKey, hash, tenantId);
    assert.strictEqual(res.status, 200);
    const body = await res.json() as {
      scheme: string;
      version: number;
      templateHash: string;
      acceptEndpoint: string;
      verifyEndpoint: string;
      revokeEndpoint: string;
      expiresIn: number;
    };
    assert.strictEqual(body.scheme, "x490");
    assert.strictEqual(body.version, 1);
    assert.strictEqual(body.templateHash, hash);
    assert.ok(body.acceptEndpoint.includes(`/v1/${tenantId}/accept`));
    assert.ok(body.verifyEndpoint.includes(`/v1/${tenantId}/verify`));
    assert.ok(body.revokeEndpoint.includes(`/v1/${tenantId}/revoke`));
    assert.strictEqual(body.expiresIn, 3600);
  });
});

// ── POST /v1/:tenantId/accept ─────────────────────────────────────────────────

describe("POST /v1/:tenantId/accept", () => {
  it("404 unknown tenant", async () => {
    const { app } = makeApp();
    const res = await app.request("/v1/unknown-tenant/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateHash: "abc", partyData: { name: "Alice" } }),
    });
    assert.strictEqual(res.status, 404);
  });

  it("404 unknown templateHash", async () => {
    const { app } = makeApp();
    const { apiKey, tenantId } = await signUp(app);
    const res = await app.request(`/v1/${tenantId}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateHash: "no-such-hash", partyData: { name: "Alice" } }),
    });
    assert.strictEqual(res.status, 404);
  });

  it("200 success — returns token and contractId", async () => {
    const { app } = makeApp();
    const { apiKey, tenantId } = await signUp(app);
    const { hash } = await registerTemplate(app, apiKey);
    const res = await app.request(`/v1/${tenantId}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateHash: hash, partyData: { name: "Alice" } }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json() as { status: string; contractId: string; token: string };
    assert.strictEqual(body.status, "accepted");
    assert.ok(body.contractId.length > 0);
    assert.ok(body.token.length > 0);
  });

  it("token TTL uses persisted expiresIn from requirements (not hardcoded 3600)", async () => {
    const { app, agreements } = makeApp();
    const { apiKey, tenantId } = await signUp(app);
    const { hash } = await registerTemplate(app, apiKey);
    // Set a distinctive TTL (1 hour = 3600 is the default; use 7200 to distinguish)
    await postRequirements(app, apiKey, hash, tenantId, { expiresIn: 7200 });
    const nowBefore = Math.floor(Date.now() / 1000);
    const body = await acceptContract(app, tenantId, hash);
    assert.strictEqual(body.status, "accepted");
    // Retrieve the stored agreement to check expiresAt
    const record = await agreements.findById(body.contractId);
    assert.ok(record !== null);
    // expiresAt should be approximately nowBefore + 7200
    const ttl = record.expiresAt - record.issuedAt;
    assert.strictEqual(ttl, 7200);
  });
});

// ── GET /v1/:tenantId/verify ──────────────────────────────────────────────────

describe("GET /v1/:tenantId/verify", () => {
  it("valid token → {valid: true}", async () => {
    const { app } = makeApp();
    const { apiKey, tenantId } = await signUp(app);
    const { hash } = await registerTemplate(app, apiKey);
    const { token } = await acceptContract(app, tenantId, hash);
    const res = await app.request(`/v1/${tenantId}/verify?token=${encodeURIComponent(token)}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json() as { valid: boolean; contractId: string };
    assert.strictEqual(body.valid, true);
    assert.ok(body.contractId.length > 0);
  });

  it("invalid token → {valid: false}", async () => {
    const { app } = makeApp();
    const { tenantId } = await signUp(app);
    const res = await app.request(`/v1/${tenantId}/verify?token=notavalidtoken`);
    assert.strictEqual(res.status, 200);
    const body = await res.json() as { valid: boolean; reason?: string };
    assert.strictEqual(body.valid, false);
    assert.ok(body.reason !== undefined);
  });

  it("revoked contract → {valid: false, reason: 'contract revoked'}", async () => {
    const { app } = makeApp();
    const { apiKey, tenantId } = await signUp(app);
    const { hash } = await registerTemplate(app, apiKey);
    const { token, contractId } = await acceptContract(app, tenantId, hash);
    // Revoke the contract
    await app.request(`/v1/${tenantId}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ contractId }),
    });
    const res = await app.request(`/v1/${tenantId}/verify?token=${encodeURIComponent(token)}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json() as { valid: boolean; reason: string };
    assert.strictEqual(body.valid, false);
    assert.strictEqual(body.reason, "contract revoked");
  });
});

// ── GET /v1/agreements ────────────────────────────────────────────────────────

describe("GET /v1/agreements", () => {
  it("401 without API key", async () => {
    const { app } = makeApp();
    const res = await app.request("/v1/agreements");
    assert.strictEqual(res.status, 401);
  });

  it("200 empty list initially", async () => {
    const { app } = makeApp();
    const { apiKey } = await signUp(app);
    const res = await app.request("/v1/agreements", {
      headers: { "X-API-Key": apiKey },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json() as { agreements: unknown[]; nextCursor: string | null };
    assert.deepStrictEqual(body.agreements, []);
    assert.strictEqual(body.nextCursor, null);
  });

  it("200 with results after accepting contracts", async () => {
    const { app } = makeApp();
    const { apiKey, tenantId } = await signUp(app);
    const { hash } = await registerTemplate(app, apiKey);
    await acceptContract(app, tenantId, hash);
    await acceptContract(app, tenantId, hash);
    const res = await app.request("/v1/agreements", {
      headers: { "X-API-Key": apiKey },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json() as { agreements: unknown[] };
    assert.strictEqual(body.agreements.length, 2);
  });

  it("pagination — limit parameter", async () => {
    const { app } = makeApp();
    const { apiKey, tenantId } = await signUp(app);
    const { hash } = await registerTemplate(app, apiKey);
    // Create 5 agreements
    for (let i = 0; i < 5; i++) {
      await acceptContract(app, tenantId, hash);
    }
    const res = await app.request("/v1/agreements?limit=3", {
      headers: { "X-API-Key": apiKey },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json() as { agreements: unknown[]; nextCursor: string | null };
    assert.strictEqual(body.agreements.length, 3);
    assert.ok(body.nextCursor !== null);
  });

  it("pagination — after cursor", async () => {
    const { app } = makeApp();
    const { apiKey, tenantId } = await signUp(app);
    const { hash } = await registerTemplate(app, apiKey);
    for (let i = 0; i < 5; i++) {
      await acceptContract(app, tenantId, hash);
    }
    const page1 = await (await app.request("/v1/agreements?limit=2", {
      headers: { "X-API-Key": apiKey },
    })).json() as { agreements: Array<{ contractId: string }>; nextCursor: string | null };
    assert.ok(page1.nextCursor !== null);
    const page2 = await (await app.request(`/v1/agreements?limit=2&after=${encodeURIComponent(page1.nextCursor!)}`, {
      headers: { "X-API-Key": apiKey },
    })).json() as { agreements: Array<{ contractId: string }>; nextCursor: string | null };
    assert.strictEqual(page2.agreements.length, 2);
    const ids1 = page1.agreements.map((a) => a.contractId);
    const ids2 = page2.agreements.map((a) => a.contractId);
    assert.ok(ids2.every((id) => !ids1.includes(id)));
  });
});

// ── POST /v1/:tenantId/revoke ──────────────────────────────────────────────────

describe("POST /v1/:tenantId/revoke", () => {
  it("401 without API key", async () => {
    const { app } = makeApp();
    const { tenantId } = await signUp(app);
    const res = await app.request(`/v1/${tenantId}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contractId: "cid-1" }),
    });
    assert.strictEqual(res.status, 401);
  });

  it("404 unknown contractId", async () => {
    const { app } = makeApp();
    const { apiKey, tenantId } = await signUp(app);
    const res = await app.request(`/v1/${tenantId}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ contractId: "no-such-id" }),
    });
    assert.strictEqual(res.status, 404);
  });

  it("200 success — returns revoked: true", async () => {
    const { app } = makeApp();
    const { apiKey, tenantId } = await signUp(app);
    const { hash } = await registerTemplate(app, apiKey);
    const { contractId } = await acceptContract(app, tenantId, hash);
    const res = await app.request(`/v1/${tenantId}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ contractId }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json() as { revoked: boolean; contractId: string };
    assert.strictEqual(body.revoked, true);
    assert.strictEqual(body.contractId, contractId);
  });
});

// ── GET /v1/apikeys ────────────────────────────────────────────────────────────

describe("GET /v1/apikeys", () => {
  it("401 without API key", async () => {
    const { app } = makeApp();
    const res = await app.request("/v1/apikeys");
    assert.strictEqual(res.status, 401);
  });

  it("200 lists API keys for the tenant", async () => {
    const { app } = makeApp();
    const { apiKey, keyId } = await signUp(app);
    const res = await app.request("/v1/apikeys", {
      headers: { "X-API-Key": apiKey },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json() as { apiKeys: Array<{ keyId: string; name: string }> };
    assert.ok(Array.isArray(body.apiKeys));
    assert.strictEqual(body.apiKeys.length, 1);
    assert.strictEqual(body.apiKeys[0]?.keyId, keyId);
  });
});

// ── POST /v1/apikeys ───────────────────────────────────────────────────────────

describe("POST /v1/apikeys", () => {
  it("201 returns new keyId and apiKey", async () => {
    const { app } = makeApp();
    const { apiKey } = await signUp(app);
    const res = await app.request("/v1/apikeys", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ name: "staging" }),
    });
    assert.strictEqual(res.status, 201);
    const body = await res.json() as { keyId: string; apiKey: string; name: string };
    assert.ok(body.keyId.length > 0);
    assert.ok(body.apiKey.startsWith("sk_x490_"));
    assert.strictEqual(body.name, "staging");
  });

  it("new key can be used for authentication", async () => {
    const { app } = makeApp();
    const { apiKey } = await signUp(app);
    const { apiKey: newKey } = await (await app.request("/v1/apikeys", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ name: "new-key" }),
    })).json() as { apiKey: string; keyId: string };
    // Use the new key to list keys
    const res = await app.request("/v1/apikeys", {
      headers: { "X-API-Key": newKey },
    });
    assert.strictEqual(res.status, 200);
  });
});

// ── DELETE /v1/apikeys/:keyId ─────────────────────────────────────────────────

describe("DELETE /v1/apikeys/:keyId", () => {
  it("404 for a keyId belonging to another tenant", async () => {
    const { app } = makeApp();
    const tenant1 = await signUp(app, "Tenant 1");
    const tenant2 = await signUp(app, "Tenant 2");
    // Tenant2 tries to delete Tenant1's key
    const res = await app.request(`/v1/apikeys/${tenant1.keyId}`, {
      method: "DELETE",
      headers: { "X-API-Key": tenant2.apiKey },
    });
    assert.strictEqual(res.status, 404);
  });

  it("200 revokes the API key", async () => {
    const { app } = makeApp();
    const { apiKey, keyId } = await signUp(app);
    // Create a second key so we don't lock ourselves out
    const { apiKey: secondKey } = await (await app.request("/v1/apikeys", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ name: "second" }),
    })).json() as { apiKey: string; keyId: string };
    const res = await app.request(`/v1/apikeys/${keyId}`, {
      method: "DELETE",
      headers: { "X-API-Key": apiKey },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json() as { revoked: boolean; keyId: string };
    assert.strictEqual(body.revoked, true);
    assert.strictEqual(body.keyId, keyId);
  });

  it("revoked key fails authentication", async () => {
    const { app } = makeApp();
    const { apiKey, keyId } = await signUp(app);
    // Create a second key before revoking the first
    const { apiKey: secondKey } = await (await app.request("/v1/apikeys", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ name: "second" }),
    })).json() as { apiKey: string; keyId: string };
    // Revoke original key using second key
    await app.request(`/v1/apikeys/${keyId}`, {
      method: "DELETE",
      headers: { "X-API-Key": secondKey },
    });
    // Original key should no longer work
    const res = await app.request("/v1/apikeys", {
      headers: { "X-API-Key": apiKey },
    });
    assert.strictEqual(res.status, 401);
  });
});
