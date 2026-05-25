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
import {
  IroncladClient,
  IroncladWebhookAdapter,
  verifyIroncladSignature,
} from "../adapters/ironclad.js";
import type { IroncladWorkflow } from "../adapters/ironclad.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const WEBHOOK_SECRET = "test-ironclad-secret";
const BASE_URL = "https://facilitator.example.com";

const MOCK_WORKFLOW: IroncladWorkflow = {
  id: "wf-abc123",
  title: "Software License Agreement",
  status: "running",
  creator: { id: "u1", email: "alice@example.com", name: "Alice" },
  schemaId: "schema-nda",
  attributes: {
    licenseFee: {
      displayName: "License Fee ($)",
      type: "number",
      value: 50000,
      required: false,
    },
    termMonths: {
      displayName: "Term (months)",
      type: "number",
      value: 12,
      required: false,
    },
    counterpartyName: {
      displayName: "Counterparty Name",
      type: "shortText",
      value: null,
      required: true,
    },
  },
  signatories: [
    { id: "s1", name: "Bob Corp", email: "bob@example.com", role: "buyer" },
  ],
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
};

function makeSignature(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function makeStores() {
  return {
    tenants: new InMemoryTenantStore(),
    templates: new InMemoryTemplateStore(),
    agreements: new InMemoryAgreementStore(),
    requirements: new InMemoryRequirementsStore(),
    webhooks: new InMemoryWebhookStore(),
    integrations: new InMemoryIntegrationStore(),
  };
}

// ── verifyIroncladSignature ───────────────────────────────────────────────────

describe("verifyIroncladSignature", () => {
  it("returns true for a valid signature", () => {
    const body = JSON.stringify({ event: "workflow_created" });
    const sig = makeSignature(body, WEBHOOK_SECRET);
    assert.ok(verifyIroncladSignature(body, sig, WEBHOOK_SECRET));
  });

  it("returns false for a tampered body", () => {
    const body = JSON.stringify({ event: "workflow_created" });
    const sig = makeSignature(body, WEBHOOK_SECRET);
    const tampered = JSON.stringify({ event: "workflow_approved" });
    assert.ok(!verifyIroncladSignature(tampered, sig, WEBHOOK_SECRET));
  });

  it("returns false for a wrong secret", () => {
    const body = JSON.stringify({ event: "workflow_created" });
    const sig = makeSignature(body, "wrong-secret");
    assert.ok(!verifyIroncladSignature(body, sig, WEBHOOK_SECRET));
  });

  it("returns false for a missing 'sha256=' prefix", () => {
    const body = "hello";
    assert.ok(!verifyIroncladSignature(body, "badhash", WEBHOOK_SECRET));
  });

  it("returns false for an empty signature header", () => {
    assert.ok(!verifyIroncladSignature("body", "", WEBHOOK_SECRET));
  });
});

// ── IroncladWebhookAdapter.onWorkflowCreated ─────────────────────────────────

describe("IroncladWebhookAdapter.onWorkflowCreated", () => {
  function makeAdapter(
    stores: ReturnType<typeof makeStores>,
    clientOverrides: Partial<InstanceType<typeof IroncladClient>> = {},
  ) {
    const mockClient = {
      getWorkflow: async () => MOCK_WORKFLOW,
      listDocuments: async () => [],
      getDocumentContent: async () => new ArrayBuffer(0),
      addComment: async () => undefined,
      updateAttributes: async () => undefined,
    } as unknown as InstanceType<typeof IroncladClient>;

    Object.assign(mockClient, clientOverrides);

    const { tenants: _t, ...adapterStores } = stores;
    return new IroncladWebhookAdapter({
      client: mockClient,
      templates: stores.templates,
      requirements: stores.requirements,
      integrations: stores.integrations,
      tenantId: "tenant-1",
      facilitatorBaseUrl: BASE_URL,
    });
  }

  it("registers template and returns acceptUrl", async () => {
    const stores = makeStores();
    const adapter = makeAdapter(stores);
    const result = await adapter.onWorkflowCreated("wf-abc123");

    assert.ok(result.acceptUrl.includes("/v1/tenant-1/accept"));
    assert.ok(result.templateHash.length === 64, "templateHash should be 64-char hex");
    assert.equal(result.workflowId, "wf-abc123");
  });

  it("stores the template content-addressed", async () => {
    const stores = makeStores();
    const adapter = makeAdapter(stores);
    const result = await adapter.onWorkflowCreated("wf-abc123");

    const tmpl = await stores.templates.findByHash(result.templateHash);
    assert.ok(tmpl !== null, "template should be findable by hash");
    assert.ok(tmpl.content.includes("Software License Agreement"));
  });

  it("builds negotiable fields from non-required numeric/text attributes", async () => {
    const stores = makeStores();
    const adapter = makeAdapter(stores);
    const result = await adapter.onWorkflowCreated("wf-abc123");

    const req = await stores.requirements.findByTemplate("tenant-1", result.templateHash);
    assert.ok(req !== null, "requirements should be created");
    assert.ok(req.negotiable, "should be negotiable (has non-required attributes)");
    const fieldNames = (req.negotiableFields ?? []).map((f) => f.field);
    assert.ok(fieldNames.includes("licenseFee"), "licenseFee should be negotiable");
    assert.ok(fieldNames.includes("termMonths"), "termMonths should be negotiable");
    assert.ok(!fieldNames.includes("counterpartyName"), "required fields should not be negotiable");
  });

  it("stores integration mapping", async () => {
    const stores = makeStores();
    const adapter = makeAdapter(stores);
    const result = await adapter.onWorkflowCreated("wf-abc123");

    const mapping = await stores.integrations.findByExternal("ironclad", "wf-abc123");
    assert.ok(mapping !== null, "integration mapping should be stored");
    assert.equal(mapping.templateHash, result.templateHash);
    assert.equal(mapping.source, "ironclad");
  });

  it("is idempotent — second call returns same templateHash", async () => {
    const stores = makeStores();
    const adapter = makeAdapter(stores);

    const r1 = await adapter.onWorkflowCreated("wf-abc123");
    const r2 = await adapter.onWorkflowCreated("wf-abc123");

    assert.equal(r1.templateHash, r2.templateHash);
  });

  it("uses document content when primary document is available", async () => {
    const stores = makeStores();
    const docContent = "This is the actual contract PDF text content.";
    const docBuf = new TextEncoder().encode(docContent).buffer;
    const adapter = makeAdapter(stores, {
      listDocuments: async () => [
        { id: "doc-1", name: "Agreement.docx", type: "primary", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      ],
      getDocumentContent: async () => docBuf,
    } as Partial<InstanceType<typeof IroncladClient>>);

    const result = await adapter.onWorkflowCreated("wf-with-doc");
    const tmpl = await stores.templates.findByHash(result.templateHash);
    assert.ok(tmpl !== null);
    assert.ok(tmpl.content.includes("actual contract"));
  });

  it("includes clause markers for each attribute in generated template", async () => {
    const stores = makeStores();
    const adapter = makeAdapter(stores);
    const result = await adapter.onWorkflowCreated("wf-abc123");

    const tmpl = await stores.templates.findByHash(result.templateHash);
    assert.ok(tmpl !== null);
    assert.ok(tmpl.content.includes("<!-- clause:licenseFee -->"), "should have clause marker for licenseFee");
    assert.ok(tmpl.content.includes("<!-- clause:termMonths -->"), "should have clause marker for termMonths");
  });
});

// ── IroncladWebhookAdapter.onAgreementAccepted ────────────────────────────────

describe("IroncladWebhookAdapter.onAgreementAccepted", () => {
  it("calls addComment with the accepting party's name", async () => {
    const comments: string[] = [];
    const stores = makeStores();
    const adapter = new IroncladWebhookAdapter({
      client: {
        getWorkflow: async () => MOCK_WORKFLOW,
        listDocuments: async () => [],
        getDocumentContent: async () => new ArrayBuffer(0),
        addComment: async (_id: string, comment: string) => { comments.push(comment); },
        updateAttributes: async () => undefined,
      } as unknown as InstanceType<typeof IroncladClient>,
      templates: stores.templates,
      requirements: stores.requirements,
      integrations: stores.integrations,
      tenantId: "tenant-1",
      facilitatorBaseUrl: BASE_URL,
    });

    await adapter.onAgreementAccepted("wf-abc123", { name: "Bob Corp", email: "bob@example.com" });
    assert.ok(comments.length === 1);
    assert.ok(comments[0]?.includes("Bob Corp"));
    assert.ok(comments[0]?.includes("x490 protocol"));
  });

  it("pushes negotiated attribute values to Ironclad", async () => {
    const updates: Record<string, unknown>[] = [];
    const stores = makeStores();
    const adapter = new IroncladWebhookAdapter({
      client: {
        getWorkflow: async () => MOCK_WORKFLOW,
        listDocuments: async () => [],
        getDocumentContent: async () => new ArrayBuffer(0),
        addComment: async () => undefined,
        updateAttributes: async (_id: string, attrs: Record<string, unknown>) => { updates.push(attrs); },
      } as unknown as InstanceType<typeof IroncladClient>,
      templates: stores.templates,
      requirements: stores.requirements,
      integrations: stores.integrations,
      tenantId: "tenant-1",
      facilitatorBaseUrl: BASE_URL,
    });

    await adapter.onAgreementAccepted(
      "wf-abc123",
      { name: "Bob" },
      { licenseFee: 45000, termMonths: 24 },
    );
    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.["licenseFee"], 45000);
    assert.equal(updates[0]?.["termMonths"], 24);
  });

  it("does not call updateAttributes when no negotiation terms provided", async () => {
    const updates: Record<string, unknown>[] = [];
    const stores = makeStores();
    const adapter = new IroncladWebhookAdapter({
      client: {
        addComment: async () => undefined,
        updateAttributes: async (_id: string, attrs: Record<string, unknown>) => { updates.push(attrs); },
      } as unknown as InstanceType<typeof IroncladClient>,
      templates: stores.templates,
      requirements: stores.requirements,
      integrations: stores.integrations,
      tenantId: "tenant-1",
      facilitatorBaseUrl: BASE_URL,
    });

    await adapter.onAgreementAccepted("wf-abc123", { name: "Bob" });
    assert.equal(updates.length, 0, "updateAttributes should not be called with no terms");
  });
});

// ── Ironclad webhook route (via HTTP) ─────────────────────────────────────────

describe("POST /v1/integrations/ironclad/webhook", () => {
  async function makeApp() {
    const stores = makeStores();
    const { tenant, rawApiKey } = await stores.tenants.create("Test Org");

    const comments: string[] = [];
    const adapter = new IroncladWebhookAdapter({
      client: {
        getWorkflow: async () => MOCK_WORKFLOW,
        listDocuments: async () => [],
        getDocumentContent: async () => new ArrayBuffer(0),
        addComment: async (_id: string, c: string) => { comments.push(c); },
        updateAttributes: async () => undefined,
      } as unknown as InstanceType<typeof IroncladClient>,
      templates: stores.templates,
      requirements: stores.requirements,
      integrations: stores.integrations,
      tenantId: tenant.tenantId,
      facilitatorBaseUrl: BASE_URL,
    });

    const app = createFacilitatorApp({
      ...stores,
      baseUrl: BASE_URL,
      ironclad: { webhookSecret: WEBHOOK_SECRET, adapter },
    });

    return { app, tenant, rawApiKey, stores, comments };
  }

  it("rejects requests with an invalid signature", async () => {
    const { app } = await makeApp();
    const body = JSON.stringify({ event: "workflow_created", payload: { workflowId: "wf-1" } });
    const res = await app.request("/v1/integrations/ironclad/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Ironclad-Hmac-Sha256": "sha256=badsig" },
      body,
    });
    assert.equal(res.status, 401);
  });

  it("registers workflow on workflow_created event", async () => {
    const { app, stores } = await makeApp();
    const body = JSON.stringify({ event: "workflow_created", payload: { workflowId: "wf-abc123" } });
    const sig = makeSignature(body, WEBHOOK_SECRET);
    const res = await app.request("/v1/integrations/ironclad/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Ironclad-Hmac-Sha256": sig },
      body,
    });
    assert.equal(res.status, 200);
    const json = await res.json() as { acceptUrl: string; templateHash: string };
    assert.ok(json.acceptUrl.includes("/accept"));
    assert.ok(json.templateHash.length === 64);

    // Template should now be in the store
    const tmpl = await stores.templates.findByHash(json.templateHash);
    assert.ok(tmpl !== null, "template should be registered");
  });

  it("acknowledges unknown events without error", async () => {
    const { app } = await makeApp();
    const body = JSON.stringify({ event: "workflow_approved", payload: { workflowId: "wf-abc123" } });
    const sig = makeSignature(body, WEBHOOK_SECRET);
    const res = await app.request("/v1/integrations/ironclad/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Ironclad-Hmac-Sha256": sig },
      body,
    });
    assert.equal(res.status, 200);
    const json = await res.json() as { received: boolean };
    assert.equal(json.received, true);
  });

  it("returns 400 when workflowId is missing from payload", async () => {
    const { app } = await makeApp();
    const body = JSON.stringify({ event: "workflow_created", payload: {} });
    const sig = makeSignature(body, WEBHOOK_SECRET);
    const res = await app.request("/v1/integrations/ironclad/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Ironclad-Hmac-Sha256": sig },
      body,
    });
    assert.equal(res.status, 400);
  });

  it("onAgreementCreated hook fires after x490 accept", async () => {
    const stores = makeStores();
    const { tenant } = await stores.tenants.create("Test Org");
    const onCreated: Array<{ record: unknown; terms: unknown }> = [];

    const app = createFacilitatorApp({
      ...stores,
      baseUrl: BASE_URL,
      onAgreementCreated: async (record, terms) => { onCreated.push({ record, terms }); },
    });

    // Register a template and requirements manually
    const tmpl = await stores.templates.register(tenant.tenantId, "# NDA\nThis is the agreement.", {});
    await stores.requirements.upsert({
      tenantId: tenant.tenantId,
      templateHash: tmpl.hash,
      resource: "*",
      expiresIn: 3600,
      requiredPartyFields: ["name"],
    });

    const body = JSON.stringify({
      templateId: "com.example.nda",
      templateHash: tmpl.hash,
      partyData: { name: "Bob Corp" },
    });
    const res = await app.request(`/v1/${tenant.tenantId}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    assert.equal(res.status, 200);
    // Give the fire-and-forget a tick to run
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(onCreated.length, 1, "onAgreementCreated should have been called");
  });
});
