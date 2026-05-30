/**
 * FacilitatorClient SDK integration tests.
 *
 * Each test boots a real in-process facilitator app and exercises the SDK
 * methods against it — no network required, no mocking.
 */
import { describe, it, expect } from "vitest";
import { FacilitatorClient, signUp } from "../client.js";
import { createFacilitatorApp } from "../app.js";
import {
  InMemoryTenantStore,
  InMemoryTemplateStore,
  InMemoryAgreementStore,
  InMemoryRequirementsStore,
  InMemoryWebhookStore,
  InMemoryEventStore,
  InMemoryWebhookDeliveryStore,
} from "../store.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeEnv() {
  const tenants = new InMemoryTenantStore();
  const templates = new InMemoryTemplateStore();
  const agreements = new InMemoryAgreementStore();
  const requirements = new InMemoryRequirementsStore();
  const webhooks = new InMemoryWebhookStore();
  const events = new InMemoryEventStore(agreements);
  const deliveries = new InMemoryWebhookDeliveryStore();

  const { rawApiKey, tenant } = await tenants.create("Acme");
  const app = createFacilitatorApp({
    tenants, templates, agreements, requirements, webhooks, events, deliveries,
    baseUrl: "http://localhost:3000",
  });

  const sdk = new FacilitatorClient({
    apiKey: rawApiKey,
    tenantId: tenant.tenantId,
    baseUrl: "http://localhost:3000",
  });

  // Override fetch to route through the in-process app
  const fetch = (url: string | URL | Request, init?: RequestInit) =>
    app.request(typeof url === "string" ? url.replace("http://localhost:3000", "") : String(url), init ?? {});

  return { sdk, tenant, rawApiKey, app, templates, agreements, events, deliveries, fetch };
}

// ── signUp ────────────────────────────────────────────────────────────────────

describe("signUp", () => {
  it("creates a tenant and returns an API key", async () => {
    const { app } = await makeEnv();
    const originalFetch = global.fetch;
    global.fetch = (url: string | URL | Request, init?: RequestInit) =>
      app.request(String(url).replace("http://localhost:3000", ""), init ?? {});

    const result = await signUp("NewCo", "http://localhost:3000");
    expect(result.tenantId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.apiKey).toMatch(/^sk_x490_/);
    expect(result.keyId).toBeTruthy();

    global.fetch = originalFetch;
  });
});

// ── Templates ─────────────────────────────────────────────────────────────────

describe("FacilitatorClient.uploadTemplate", () => {
  it("returns a hash and url", async () => {
    const { sdk, app } = await makeEnv();
    global.fetch = (url, init) => app.request(String(url).replace("http://localhost:3000", ""), init as RequestInit ?? {});

    const result = await sdk.uploadTemplate("Pay {{amount}} for {{service}}.", { title: "Contract" });
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.url).toContain(result.hash);
  });
});

describe("FacilitatorClient.listTemplates", () => {
  it("returns uploaded templates with cursor pagination", async () => {
    const { sdk, app } = await makeEnv();
    global.fetch = (url, init) => app.request(String(url).replace("http://localhost:3000", ""), init as RequestInit ?? {});

    await sdk.uploadTemplate("Template A", { title: "A" });
    await sdk.uploadTemplate("Template B", { title: "B" });

    const page = await sdk.listTemplates({ limit: 10 });
    expect(page.templates.length).toBe(2);
    expect(page.nextCursor).toBeNull();
  });
});

describe("FacilitatorClient.supersedeTemplate", () => {
  it("creates a version-linked successor", async () => {
    const { sdk, app } = await makeEnv();
    global.fetch = (url, init) => app.request(String(url).replace("http://localhost:3000", ""), init as RequestInit ?? {});

    const v1 = await sdk.uploadTemplate("Version 1: Pay {{amount}}.", { title: "v1" });
    const v2 = await sdk.supersedeTemplate(v1.hash, "Version 2: Pay {{amount}} plus {{tax}}.", {
      changeNote: "Added tax field",
    });
    expect(v2.parentHash).toBe(v1.hash);
    expect(v2.changeNote).toBe("Added tax field");
  });
});

describe("FacilitatorClient.getTemplateHistory + getTemplateChildren", () => {
  it("walks the version chain", async () => {
    const { sdk, app } = await makeEnv();
    global.fetch = (url, init) => app.request(String(url).replace("http://localhost:3000", ""), init as RequestInit ?? {});

    const v1 = await sdk.uploadTemplate("V1", { title: "v1" });
    const v2 = await sdk.supersedeTemplate(v1.hash, "V2", { changeNote: "rev 2" });

    const history = await sdk.getTemplateHistory(v2.hash);
    expect(history.map((t) => t.hash)).toEqual([v1.hash, v2.hash]);

    const children = await sdk.getTemplateChildren(v1.hash);
    expect(children.map((t) => t.hash)).toContain(v2.hash);
  });
});

// ── Agreements ────────────────────────────────────────────────────────────────

describe("FacilitatorClient.listAgreements + getAgreement", () => {
  it("round-trips an agreement through the store", async () => {
    const { sdk, app, agreements, tenant } = await makeEnv();
    global.fetch = (url, init) => app.request(String(url).replace("http://localhost:3000", ""), init as RequestInit ?? {});

    // Seed one agreement directly in the store
    await agreements.record({
      contractId: "c-123",
      tenantId: tenant.tenantId,
      templateHash: "abc",
      partyId: "party-1",
      resource: "/api/tool",
      partyData: { name: "Alice" },
      token: "tok",
      issuedAt: 1700000000,
      expiresAt: 1800000000,
    });

    const page = await sdk.listAgreements();
    expect(page.agreements.length).toBe(1);
    expect(page.agreements[0]!.contractId).toBe("c-123");

    const single = await sdk.getAgreement("c-123");
    expect(single?.partyData.name).toBe("Alice");

    const missing = await sdk.getAgreement("no-such-contract");
    expect(missing).toBeNull();
  });
});

describe("FacilitatorClient.amendAgreement + listAmendments", () => {
  it("applies changes and returns a new token", async () => {
    const { sdk, app, agreements, tenant, templates } = await makeEnv();
    global.fetch = (url, init) => app.request(String(url).replace("http://localhost:3000", ""), init as RequestInit ?? {});

    const tmpl = await templates.register(tenant.tenantId, "Pay {{amount}}.", {});
    await agreements.record({
      contractId: "c-amend",
      tenantId: tenant.tenantId,
      templateHash: tmpl.hash,
      partyId: "party-1",
      resource: "/api/tool",
      partyData: { amount: "100" },
      token: "old-tok",
      issuedAt: 1700000000,
      expiresAt: 1900000000,
    });

    const result = await sdk.amendAgreement("c-amend", {
      changes: { amount: "200" },
      reason: "Price adjustment",
    });
    expect(result.token).toBeTruthy();
    expect(result.amendment.changes).toEqual({ amount: "200" });

    const amendments = await sdk.listAmendments("c-amend");
    expect(amendments).toHaveLength(1);
    expect(amendments[0]!.reason).toBe("Price adjustment");
  });
});

describe("FacilitatorClient.renewAgreement", () => {
  it("creates a successor agreement with a new contractId", async () => {
    const { sdk, app, agreements, tenant, templates } = await makeEnv();
    global.fetch = (url, init) => app.request(String(url).replace("http://localhost:3000", ""), init as RequestInit ?? {});

    const tmpl = await templates.register(tenant.tenantId, "Pay {{amount}}.", {});
    await agreements.record({
      contractId: "c-renew",
      tenantId: tenant.tenantId,
      templateHash: tmpl.hash,
      partyId: "party-1",
      resource: "/api/tool",
      partyData: { amount: "100" },
      token: "old-tok",
      issuedAt: 1700000000,
      expiresAt: 1700001000,
    });

    const result = await sdk.renewAgreement("c-renew", { expiresIn: 86400 });
    expect(result.agreement.contractId).not.toBe("c-renew");
    expect(result.agreement.parentContractId).toBe("c-renew");
    expect(result.token).toBeTruthy();
  });
});

// ── Contract events ───────────────────────────────────────────────────────────

describe("FacilitatorClient — contract event DAG", () => {
  it("appends and retrieves events", async () => {
    const { sdk, app, agreements, tenant } = await makeEnv();
    global.fetch = (url, init) => app.request(String(url).replace("http://localhost:3000", ""), init as RequestInit ?? {});

    await agreements.record({
      contractId: "c-evt",
      tenantId: tenant.tenantId,
      templateHash: "abc",
      partyId: "party-1",
      resource: "/api/tool",
      partyData: {},
      token: "tok",
      issuedAt: 1700000000,
      expiresAt: 1900000000,
    });

    const event = await sdk.appendAgreementEvent("c-evt", "custom.signed", { signedBy: "Alice" });
    expect(event.type).toBe("custom.signed");
    expect(event.payload).toEqual({ signedBy: "Alice" });

    const events = await sdk.getAgreementEvents("c-evt");
    expect(events.map((e) => e.type)).toContain("custom.signed");
  });

  it("rejects reserved agreement. prefixed event types", async () => {
    const { sdk, app, agreements, tenant } = await makeEnv();
    global.fetch = (url, init) => app.request(String(url).replace("http://localhost:3000", ""), init as RequestInit ?? {});

    await agreements.record({
      contractId: "c-reserved",
      tenantId: tenant.tenantId,
      templateHash: "abc",
      partyId: "party-1",
      resource: "/api/tool",
      partyData: {},
      token: "tok",
      issuedAt: 1700000000,
      expiresAt: 1900000000,
    });

    await expect(sdk.appendAgreementEvent("c-reserved", "agreement.custom")).rejects.toThrow();
  });

  it("listEvents returns tenant-wide audit log", async () => {
    const { sdk, app, agreements, tenant } = await makeEnv();
    global.fetch = (url, init) => app.request(String(url).replace("http://localhost:3000", ""), init as RequestInit ?? {});

    await agreements.record({
      contractId: "c-audit",
      tenantId: tenant.tenantId,
      templateHash: "abc",
      partyId: "party-1",
      resource: "/api/tool",
      partyData: {},
      token: "tok",
      issuedAt: 1700000000,
      expiresAt: 1900000000,
    });

    await sdk.appendAgreementEvent("c-audit", "custom.reviewed");

    const page = await sdk.listEvents({ limit: 10, type: "custom.reviewed" });
    expect(page.events.length).toBe(1);
    expect(page.events[0]!.contractId).toBe("c-audit");
  });
});

// ── Observability ─────────────────────────────────────────────────────────────

describe("FacilitatorClient.getMe", () => {
  it("returns tenantId and name", async () => {
    const { sdk, app, tenant } = await makeEnv();
    global.fetch = (url, init) => app.request(String(url).replace("http://localhost:3000", ""), init as RequestInit ?? {});

    const me = await sdk.getMe();
    expect(me.tenantId).toBe(tenant.tenantId);
    expect(me.name).toBe("Acme");
  });
});

describe("FacilitatorClient.getStats", () => {
  it("returns webhook counts", async () => {
    const { sdk, app } = await makeEnv();
    global.fetch = (url, init) => app.request(String(url).replace("http://localhost:3000", ""), init as RequestInit ?? {});

    await sdk.createWebhook("https://example.com/hook", ["agreement.created"]);

    const stats = await sdk.getStats();
    expect(stats.webhooks.total).toBe(1);
    expect(stats.webhooks.active).toBe(1);
  });
});

describe("FacilitatorClient.getHealth", () => {
  it("returns ok when no healthCheck configured", async () => {
    const { sdk, app } = await makeEnv();
    global.fetch = (url, init) => app.request(String(url).replace("http://localhost:3000", ""), init as RequestInit ?? {});

    const health = await sdk.getHealth();
    expect(health.status).toBe("ok");
    expect(typeof health.timestamp).toBe("number");
  });

  it("returns degraded with components when healthCheck reports failure", async () => {
    const tenants = new InMemoryTenantStore();
    const { rawApiKey, tenant } = await tenants.create("Test");
    const app = createFacilitatorApp({
      tenants,
      templates: new InMemoryTemplateStore(),
      agreements: new InMemoryAgreementStore(),
      requirements: new InMemoryRequirementsStore(),
      webhooks: new InMemoryWebhookStore(),
      baseUrl: "http://localhost:3000",
      healthCheck: async () => ({ db: false, cache: true }),
    });
    const sdk = new FacilitatorClient({ apiKey: rawApiKey, tenantId: tenant.tenantId, baseUrl: "http://localhost:3000" });
    global.fetch = (url, init) => app.request(String(url).replace("http://localhost:3000", ""), init as RequestInit ?? {});

    const health = await sdk.getHealth();
    expect(health.status).toBe("degraded");
    expect(health.components?.db).toBe(false);
    expect(health.components?.cache).toBe(true);
  });
});

// ── Webhook deliveries ────────────────────────────────────────────────────────

describe("FacilitatorClient.listWebhookDeliveries", () => {
  it("returns delivery records for a webhook", async () => {
    const { sdk, app, deliveries } = await makeEnv();
    global.fetch = (url, init) => app.request(String(url).replace("http://localhost:3000", ""), init as RequestInit ?? {});

    const { webhookId } = await sdk.createWebhook("https://example.com/hook", ["agreement.created"]);
    await deliveries.record({
      deliveryId: "del-1",
      webhookId,
      tenantId: "tenant-1",
      eventType: "agreement.created",
      attemptCount: 1,
      createdAt: 1700000000,
    });

    const list = await sdk.listWebhookDeliveries(webhookId);
    expect(list).toHaveLength(1);
    expect(list[0]!.deliveryId).toBe("del-1");
  });
});
