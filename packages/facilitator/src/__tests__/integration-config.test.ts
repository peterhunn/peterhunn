import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createFacilitatorApp } from "../app.js";
import {
  InMemoryTenantStore,
  InMemoryTemplateStore,
  InMemoryAgreementStore,
  InMemoryRequirementsStore,
  InMemoryWebhookStore,
} from "../store.js";
import { InMemoryIntegrationStore } from "../integration-store.js";
import { InMemoryIntegrationConfigStore } from "../integration-config-store.js";
import { IroncladClient, IroncladWebhookAdapter } from "../adapters/ironclad.js";
import { DocuSignClient, DocuSignWebhookAdapter } from "../adapters/docusign.js";
import type { IroncladWorkflow } from "../adapters/ironclad.js";
import type { DocuSignEnvelope } from "../adapters/docusign.js";

const BASE_URL = "https://facilitator.example.com";

const MOCK_WORKFLOW: IroncladWorkflow = {
  id: "wf-cfg1",
  title: "Service Agreement",
  status: "running",
  creator: { id: "u1", email: "alice@example.com", name: "Alice" },
  schemaId: "schema-1",
  attributes: {
    price: { displayName: "Price ($)", type: "number", value: 1000, required: false },
  },
  signatories: [],
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
};

const MOCK_ENVELOPE: DocuSignEnvelope = {
  envelopeId: "env-cfg1",
  status: "completed",
  emailSubject: "Service Agreement",
  sender: { email: "alice@example.com", userName: "Alice" },
  recipients: {
    signers: [{ recipientId: "r1", name: "Bob", email: "bob@example.com", status: "completed" }],
  },
  createdDateTime: "2025-01-01T00:00:00Z",
  completedDateTime: "2025-01-02T00:00:00Z",
};

function sign(body: string, secret: string, algo: "hex" | "base64" = "hex") {
  return createHmac("sha256", secret).update(body, "utf8").digest(algo);
}

function makeStores() {
  return {
    tenants: new InMemoryTenantStore(),
    templates: new InMemoryTemplateStore(),
    agreements: new InMemoryAgreementStore(),
    requirements: new InMemoryRequirementsStore(),
    webhooks: new InMemoryWebhookStore(),
  };
}

async function makeApp() {
  const stores = makeStores();
  const { tenant, rawApiKey } = await stores.tenants.create("Config Corp");
  const integrationConfigs = new InMemoryIntegrationConfigStore();
  const integrations = new InMemoryIntegrationStore();

  const app = createFacilitatorApp({ ...stores, baseUrl: BASE_URL, integrationConfigs, integrations });
  return { app, tenant, rawApiKey, stores, integrationConfigs, integrations };
}

// ── InMemoryIntegrationConfigStore unit tests ─────────────────────────────────

describe("InMemoryIntegrationConfigStore", () => {
  it("upserts and retrieves a config", async () => {
    const store = new InMemoryIntegrationConfigStore();
    const cfg = await store.upsert({
      tenantId: "t1", source: "ironclad",
      credentials: { apiKey: "key123" },
      webhookSecret: "whsec",
    });
    assert.equal(cfg.source, "ironclad");
    assert.equal(cfg.credentials["apiKey"], "key123");

    const found = await store.findByTenantAndSource("t1", "ironclad");
    assert.ok(found !== null);
    assert.equal(found.webhookSecret, "whsec");
  });

  it("overwrites on second upsert, preserving createdAt", async () => {
    const store = new InMemoryIntegrationConfigStore();
    const c1 = await store.upsert({ tenantId: "t1", source: "ironclad", credentials: { apiKey: "old" }, webhookSecret: "s1" });
    const c2 = await store.upsert({ tenantId: "t1", source: "ironclad", credentials: { apiKey: "new" }, webhookSecret: "s2" });
    assert.equal(c1.id, c2.id);
    assert.equal(c1.createdAt, c2.createdAt);
    assert.equal(c2.credentials["apiKey"], "new");
  });

  it("lists by tenant", async () => {
    const store = new InMemoryIntegrationConfigStore();
    await store.upsert({ tenantId: "t1", source: "ironclad", credentials: {}, webhookSecret: "s" });
    await store.upsert({ tenantId: "t1", source: "docusign", credentials: {}, webhookSecret: "s" });
    await store.upsert({ tenantId: "t2", source: "ironclad", credentials: {}, webhookSecret: "s" });
    const list = await store.listByTenant("t1");
    assert.equal(list.length, 2);
  });

  it("removes a config", async () => {
    const store = new InMemoryIntegrationConfigStore();
    await store.upsert({ tenantId: "t1", source: "ironclad", credentials: {}, webhookSecret: "s" });
    const removed = await store.remove("t1", "ironclad");
    assert.ok(removed);
    assert.ok(await store.findByTenantAndSource("t1", "ironclad") === null);
  });

  it("returns false when removing non-existent config", async () => {
    const store = new InMemoryIntegrationConfigStore();
    assert.ok(!(await store.remove("t1", "ironclad")));
  });
});

// ── Admin API routes ──────────────────────────────────────────────────────────

describe("GET /v1/integrations", () => {
  it("returns empty list when no integrations configured", async () => {
    const { app, rawApiKey } = await makeApp();
    const res = await app.request("/v1/integrations", { headers: { "X-API-Key": rawApiKey } });
    assert.equal(res.status, 200);
    const { integrations } = await res.json() as { integrations: unknown[] };
    assert.equal(integrations.length, 0);
  });

  it("returns configured integrations without credentials", async () => {
    const { app, rawApiKey, tenant, integrationConfigs } = await makeApp();
    await integrationConfigs.upsert({
      tenantId: tenant.tenantId, source: "ironclad",
      credentials: { apiKey: "secret-key" }, webhookSecret: "whsec",
    });
    const res = await app.request("/v1/integrations", { headers: { "X-API-Key": rawApiKey } });
    const { integrations } = await res.json() as { integrations: Array<Record<string, unknown>> };
    assert.equal(integrations.length, 1);
    assert.ok(!("credentials" in integrations[0]!), "credentials should not be exposed");
    assert.ok(!("webhookSecret" in integrations[0]!), "webhookSecret should not be exposed");
  });

  it("requires authentication", async () => {
    const { app } = await makeApp();
    const res = await app.request("/v1/integrations");
    assert.equal(res.status, 401);
  });
});

describe("PUT /v1/integrations/:source", () => {
  it("upserts an Ironclad config and returns webhookUrl", async () => {
    const { app, rawApiKey, tenant } = await makeApp();
    const res = await app.request("/v1/integrations/ironclad", {
      method: "PUT",
      headers: { "X-API-Key": rawApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: { apiKey: "ic-key" }, webhookSecret: "ic-secret" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { webhookUrl: string; source: string };
    assert.equal(body.source, "ironclad");
    assert.ok(body.webhookUrl.includes(`/v1/${tenant.tenantId}/integrations/ironclad/webhook`));
  });

  it("returns 400 for unknown source", async () => {
    const { app, rawApiKey } = await makeApp();
    const res = await app.request("/v1/integrations/fakeplatform", {
      method: "PUT",
      headers: { "X-API-Key": rawApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ webhookSecret: "s" }),
    });
    assert.equal(res.status, 400);
  });

  it("returns 400 when webhookSecret is missing", async () => {
    const { app, rawApiKey } = await makeApp();
    const res = await app.request("/v1/integrations/ironclad", {
      method: "PUT",
      headers: { "X-API-Key": rawApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: {} }),
    });
    assert.equal(res.status, 400);
  });
});

describe("DELETE /v1/integrations/:source", () => {
  it("removes a configured integration", async () => {
    const { app, rawApiKey, tenant, integrationConfigs } = await makeApp();
    await integrationConfigs.upsert({
      tenantId: tenant.tenantId, source: "docusign", credentials: {}, webhookSecret: "s",
    });
    const res = await app.request("/v1/integrations/docusign", {
      method: "DELETE",
      headers: { "X-API-Key": rawApiKey },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { removed: boolean };
    assert.ok(body.removed);
  });
});

// ── Dashboard route ───────────────────────────────────────────────────────────

describe("GET /v1/dashboard", () => {
  it("returns 200 with HTML content-type when integrationConfigs is configured", async () => {
    const { app } = await makeApp();
    const res = await app.request("/v1/dashboard");
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("content-type")?.includes("text/html"));
  });

  it("includes the API base URL in the page", async () => {
    const { app } = await makeApp();
    const res = await app.request("/v1/dashboard");
    const html = await res.text();
    assert.ok(html.includes("facilitator.example.com"));
  });

  it("includes integration cards for Ironclad and DocuSign", async () => {
    const { app } = await makeApp();
    const html = await (await app.request("/v1/dashboard")).text();
    assert.ok(html.includes("Ironclad"));
    assert.ok(html.includes("DocuSign"));
  });
});

// ── Dynamic webhook routes ────────────────────────────────────────────────────

describe("POST /v1/:tenantId/integrations/ironclad/webhook (dynamic)", () => {
  it("returns 404 when Ironclad is not configured for this tenant", async () => {
    const { app, tenant } = await makeApp();
    const body = JSON.stringify({ event: "workflow_created", payload: { workflowId: "wf-1" } });
    const sig = "sha256=" + sign(body, "any", "hex");
    const res = await app.request(`/v1/${tenant.tenantId}/integrations/ironclad/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Ironclad-Hmac-Sha256": sig },
      body,
    });
    assert.equal(res.status, 404);
  });

  it("rejects invalid signatures", async () => {
    const { app, tenant, integrationConfigs } = await makeApp();
    await integrationConfigs.upsert({
      tenantId: tenant.tenantId, source: "ironclad",
      credentials: { apiKey: "k" }, webhookSecret: "real-secret",
    });
    const body = JSON.stringify({ event: "workflow_created", payload: { workflowId: "wf-1" } });
    const res = await app.request(`/v1/${tenant.tenantId}/integrations/ironclad/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Ironclad-Hmac-Sha256": "sha256=badsig" },
      body,
    });
    assert.equal(res.status, 401);
  });

  it("registers workflow on valid workflow_created event", async () => {
    const { app, tenant, integrationConfigs, stores } = await makeApp();
    const secret = "ironclad-wh-secret";
    await integrationConfigs.upsert({
      tenantId: tenant.tenantId, source: "ironclad",
      credentials: { apiKey: "ic-api-key" }, webhookSecret: secret,
    });

    // Patch IroncladClient to avoid real HTTP calls
    const origGet = IroncladClient.prototype.getWorkflow;
    const origDocs = IroncladClient.prototype.listDocuments;
    IroncladClient.prototype.getWorkflow = async () => MOCK_WORKFLOW;
    IroncladClient.prototype.listDocuments = async () => [];

    try {
      const body = JSON.stringify({ event: "workflow_created", payload: { workflowId: "wf-cfg1" } });
      const sig = "sha256=" + sign(body, secret, "hex");
      const res = await app.request(`/v1/${tenant.tenantId}/integrations/ironclad/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Ironclad-Hmac-Sha256": sig },
        body,
      });
      assert.equal(res.status, 200);
      const json = await res.json() as { templateHash: string };
      assert.ok(json.templateHash.length === 64);

      const tmpl = await stores.templates.findByHash(json.templateHash);
      assert.ok(tmpl !== null, "template should be registered");
    } finally {
      IroncladClient.prototype.getWorkflow = origGet;
      IroncladClient.prototype.listDocuments = origDocs;
    }
  });
});

describe("POST /v1/:tenantId/integrations/docusign/webhook (dynamic)", () => {
  it("returns 404 when DocuSign is not configured for this tenant", async () => {
    const { app, tenant } = await makeApp();
    const body = JSON.stringify({ event: "envelope-completed", apiVersion: "v2.1", uri: "", retryCount: 0, configurationId: 1, generatedDateTime: "", data: { accountId: "a", envelopeId: "e1" } });
    const sig = sign(body, "any", "base64");
    const res = await app.request(`/v1/${tenant.tenantId}/integrations/docusign/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-DocuSign-Signature-1": sig },
      body,
    });
    assert.equal(res.status, 404);
  });

  it("processes envelope-completed with valid signature", async () => {
    const { app, tenant, integrationConfigs, stores } = await makeApp();
    const secret = "docusign-wh-secret";
    await integrationConfigs.upsert({
      tenantId: tenant.tenantId, source: "docusign",
      credentials: { accessToken: "tok", accountId: "acc-1" }, webhookSecret: secret,
    });

    // Patch DocuSignClient to avoid real HTTP calls
    const origGet = DocuSignClient.prototype.getEnvelope;
    const origDocs = DocuSignClient.prototype.listDocuments;
    DocuSignClient.prototype.getEnvelope = async () => MOCK_ENVELOPE;
    DocuSignClient.prototype.listDocuments = async () => [];

    try {
      const body = JSON.stringify({
        event: "envelope-completed", apiVersion: "v2.1", uri: "", retryCount: 0,
        configurationId: 1, generatedDateTime: "",
        data: { accountId: "acc-1", envelopeId: "env-cfg1", envelopeSummary: MOCK_ENVELOPE },
      });
      const sig = sign(body, secret, "base64");
      const res = await app.request(`/v1/${tenant.tenantId}/integrations/docusign/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-DocuSign-Signature-1": sig },
        body,
      });
      assert.equal(res.status, 200);
      const json = await res.json() as { contractIds: string[] };
      assert.equal(json.contractIds.length, 1);

      const agreement = await stores.agreements.findById(json.contractIds[0]!);
      assert.ok(agreement !== null);
      assert.equal(agreement.externalSource, "docusign");
    } finally {
      DocuSignClient.prototype.getEnvelope = origGet;
      DocuSignClient.prototype.listDocuments = origDocs;
    }
  });
});
