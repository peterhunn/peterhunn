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
  DocuSignClient,
  DocuSignWebhookAdapter,
  verifyDocuSignSignature,
} from "../adapters/docusign.js";
import type { DocuSignEnvelope } from "../adapters/docusign.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const WEBHOOK_SECRET = "test-docusign-secret";
const BASE_URL = "https://facilitator.example.com";

const MOCK_ENVELOPE: DocuSignEnvelope = {
  envelopeId: "env-abc123",
  status: "completed",
  emailSubject: "Software License Agreement",
  sender: { email: "alice@example.com", userName: "Alice" },
  recipients: {
    signers: [
      { recipientId: "r1", name: "Bob Corp", email: "bob@example.com", status: "completed" },
      { recipientId: "r2", name: "Carol Ltd", email: "carol@example.com", status: "completed" },
    ],
  },
  createdDateTime: "2025-01-01T00:00:00Z",
  completedDateTime: "2025-01-02T00:00:00Z",
};

function makeSignature(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("base64");
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

function makeMockClient(overrides: Partial<InstanceType<typeof DocuSignClient>> = {}) {
  const base = {
    getEnvelope: async () => MOCK_ENVELOPE,
    getRecipients: async () => ({ signers: MOCK_ENVELOPE.recipients?.signers ?? [] }),
    listDocuments: async () => [],
    getDocumentContent: async () => new ArrayBuffer(0),
  } as unknown as InstanceType<typeof DocuSignClient>;
  return Object.assign(base, overrides);
}

// ── verifyDocuSignSignature ───────────────────────────────────────────────────

describe("verifyDocuSignSignature", () => {
  it("returns true for a valid base64 signature", () => {
    const body = JSON.stringify({ event: "envelope-completed" });
    const sig = makeSignature(body, WEBHOOK_SECRET);
    assert.ok(verifyDocuSignSignature(body, sig, WEBHOOK_SECRET));
  });

  it("returns false for a tampered body", () => {
    const body = JSON.stringify({ event: "envelope-completed" });
    const sig = makeSignature(body, WEBHOOK_SECRET);
    assert.ok(!verifyDocuSignSignature('{"event":"envelope-sent"}', sig, WEBHOOK_SECRET));
  });

  it("returns false for a wrong secret", () => {
    const body = "hello";
    const sig = makeSignature(body, "wrong-secret");
    assert.ok(!verifyDocuSignSignature(body, sig, WEBHOOK_SECRET));
  });

  it("returns false for an empty signature header", () => {
    assert.ok(!verifyDocuSignSignature("body", "", WEBHOOK_SECRET));
  });
});

// ── DocuSignWebhookAdapter.onEnvelopeCompleted ────────────────────────────────

describe("DocuSignWebhookAdapter.onEnvelopeCompleted", () => {
  function makeAdapter(
    stores: ReturnType<typeof makeStores>,
    hmacSecret: string,
    clientOverrides: Partial<InstanceType<typeof DocuSignClient>> = {},
  ) {
    return new DocuSignWebhookAdapter({
      client: makeMockClient(clientOverrides),
      templates: stores.templates,
      requirements: stores.requirements,
      agreements: stores.agreements,
      integrations: stores.integrations,
      tenantId: "tenant-1",
      hmacSecret,
      facilitatorBaseUrl: BASE_URL,
    });
  }

  it("registers template and returns correct shape", async () => {
    const stores = makeStores();
    const adapter = makeAdapter(stores, "secret");
    const result = await adapter.onEnvelopeCompleted("env-abc123", MOCK_ENVELOPE);

    assert.equal(result.envelopeId, "env-abc123");
    assert.ok(result.templateHash.length === 64);
    assert.ok(result.acceptUrl.includes("/v1/tenant-1/accept"));
  });

  it("records one agreement per completed signer", async () => {
    const stores = makeStores();
    const adapter = makeAdapter(stores, "secret");
    const result = await adapter.onEnvelopeCompleted("env-abc123", MOCK_ENVELOPE);

    assert.equal(result.contractIds.length, 2, "should record one agreement per signer");
  });

  it("stores agreements with externalSource=docusign and externalId=envelopeId", async () => {
    const stores = makeStores();
    const adapter = makeAdapter(stores, "secret");
    const result = await adapter.onEnvelopeCompleted("env-abc123", MOCK_ENVELOPE);

    const record = await stores.agreements.findById(result.contractIds[0]!);
    assert.ok(record !== null);
    assert.equal(record.externalSource, "docusign");
    assert.equal(record.externalId, "env-abc123");
  });

  it("stores the integration mapping", async () => {
    const stores = makeStores();
    const adapter = makeAdapter(stores, "secret");
    const result = await adapter.onEnvelopeCompleted("env-abc123", MOCK_ENVELOPE);

    const mapping = await stores.integrations.findByExternal("docusign", "env-abc123");
    assert.ok(mapping !== null);
    assert.equal(mapping.templateHash, result.templateHash);
  });

  it("is idempotent — second call returns same templateHash", async () => {
    const stores = makeStores();
    const adapter = makeAdapter(stores, "secret");

    const r1 = await adapter.onEnvelopeCompleted("env-abc123", MOCK_ENVELOPE);
    const r2 = await adapter.onEnvelopeCompleted("env-abc123", MOCK_ENVELOPE);

    assert.equal(r1.templateHash, r2.templateHash);
  });

  it("uses document content when available", async () => {
    const stores = makeStores();
    const docContent = "This is the actual contract text.";
    const adapter = makeAdapter(stores, "secret", {
      listDocuments: async () => [
        { documentId: "doc-1", name: "Agreement.pdf", type: "content", uri: "/docs/doc-1" },
      ],
      getDocumentContent: async () => new TextEncoder().encode(docContent).buffer,
    } as Partial<InstanceType<typeof DocuSignClient>>);

    const result = await adapter.onEnvelopeCompleted("env-with-doc", MOCK_ENVELOPE);
    const tmpl = await stores.templates.findByHash(result.templateHash);
    assert.ok(tmpl !== null);
    assert.ok(tmpl.content.includes("actual contract text"));
  });

  it("skips signers that have not yet completed", async () => {
    const partialEnvelope: DocuSignEnvelope = {
      ...MOCK_ENVELOPE,
      status: "sent",
      recipients: {
        signers: [
          { recipientId: "r1", name: "Bob Corp", email: "bob@example.com", status: "completed" },
          { recipientId: "r2", name: "Carol Ltd", email: "carol@example.com", status: "sent" },
        ],
      },
    };
    const stores = makeStores();
    const adapter = makeAdapter(stores, "secret");
    const result = await adapter.onEnvelopeCompleted("env-partial", partialEnvelope);

    assert.equal(result.contractIds.length, 1, "only the completed signer should be recorded");
  });

  it("calls onAgreementRecorded for each signer", async () => {
    const stores = makeStores();
    const recorded: string[] = [];
    const adapter = new DocuSignWebhookAdapter({
      client: makeMockClient(),
      templates: stores.templates,
      requirements: stores.requirements,
      agreements: stores.agreements,
      integrations: stores.integrations,
      tenantId: "tenant-1",
      hmacSecret: "secret",
      facilitatorBaseUrl: BASE_URL,
      onAgreementRecorded: async (record) => { recorded.push(record.partyId); },
    });

    await adapter.onEnvelopeCompleted("env-abc123", MOCK_ENVELOPE);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(recorded.length, 2);
    assert.ok(recorded.includes("bob@example.com"));
    assert.ok(recorded.includes("carol@example.com"));
  });

  it("does not fail when onAgreementRecorded throws", async () => {
    const stores = makeStores();
    const adapter = new DocuSignWebhookAdapter({
      client: makeMockClient(),
      templates: stores.templates,
      requirements: stores.requirements,
      agreements: stores.agreements,
      integrations: stores.integrations,
      tenantId: "tenant-1",
      hmacSecret: "secret",
      facilitatorBaseUrl: BASE_URL,
      onAgreementRecorded: async () => { throw new Error("downstream failed"); },
    });

    await assert.doesNotReject(() => adapter.onEnvelopeCompleted("env-abc123", MOCK_ENVELOPE));
  });
});

// ── POST /v1/integrations/docusign/webhook HTTP route ─────────────────────────

describe("POST /v1/integrations/docusign/webhook", () => {
  async function makeApp() {
    const stores = makeStores();
    const { tenant, rawApiKey } = await stores.tenants.create("Test Org");

    const adapter = new DocuSignWebhookAdapter({
      client: makeMockClient(),
      templates: stores.templates,
      requirements: stores.requirements,
      agreements: stores.agreements,
      integrations: stores.integrations,
      tenantId: tenant.tenantId,
      hmacSecret: tenant.hmacSecret ?? "fallback-secret",
      facilitatorBaseUrl: BASE_URL,
    });

    const app = createFacilitatorApp({
      ...stores,
      baseUrl: BASE_URL,
      docusign: { webhookSecret: WEBHOOK_SECRET, adapter },
    });

    return { app, tenant, rawApiKey, stores };
  }

  it("rejects requests with an invalid signature", async () => {
    const { app } = await makeApp();
    const body = JSON.stringify({ event: "envelope-completed", data: { envelopeId: "env-1" } });
    const res = await app.request("/v1/integrations/docusign/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-DocuSign-Signature-1": "invalidsig" },
      body,
    });
    assert.equal(res.status, 401);
  });

  it("processes envelope-completed and records agreements", async () => {
    const { app, stores } = await makeApp();
    const body = JSON.stringify({
      event: "envelope-completed",
      apiVersion: "v2.1",
      uri: "/restapi/v2.1/accounts/acc-1/envelopes/env-abc123",
      retryCount: 0,
      configurationId: 1,
      generatedDateTime: "2025-01-01T00:00:00Z",
      data: { accountId: "acc-1", envelopeId: "env-abc123", envelopeSummary: MOCK_ENVELOPE },
    });
    const sig = makeSignature(body, WEBHOOK_SECRET);
    const res = await app.request("/v1/integrations/docusign/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-DocuSign-Signature-1": sig },
      body,
    });
    assert.equal(res.status, 200);
    const json = await res.json() as { templateHash: string; contractIds: string[] };
    assert.ok(json.templateHash.length === 64);
    assert.equal(json.contractIds.length, 2);

    // Agreements should be in the store
    const record = await stores.agreements.findById(json.contractIds[0]!);
    assert.ok(record !== null);
  });

  it("acknowledges non-completed events without action", async () => {
    const { app } = await makeApp();
    const body = JSON.stringify({
      event: "envelope-sent",
      apiVersion: "v2.1",
      uri: "",
      retryCount: 0,
      configurationId: 1,
      generatedDateTime: "2025-01-01T00:00:00Z",
      data: { accountId: "acc-1", envelopeId: "env-abc123" },
    });
    const sig = makeSignature(body, WEBHOOK_SECRET);
    const res = await app.request("/v1/integrations/docusign/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-DocuSign-Signature-1": sig },
      body,
    });
    assert.equal(res.status, 200);
    const json = await res.json() as { received: boolean };
    assert.equal(json.received, true);
  });

  it("returns 400 when envelopeId is missing", async () => {
    const { app } = await makeApp();
    const body = JSON.stringify({
      event: "envelope-completed",
      apiVersion: "v2.1",
      uri: "",
      retryCount: 0,
      configurationId: 1,
      generatedDateTime: "2025-01-01T00:00:00Z",
      data: { accountId: "acc-1" },
    });
    const sig = makeSignature(body, WEBHOOK_SECRET);
    const res = await app.request("/v1/integrations/docusign/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-DocuSign-Signature-1": sig },
      body,
    });
    assert.equal(res.status, 400);
  });
});

// ── Direct API mode — externalId on /accept + GET /v1/agreements/by-external ─

describe("Direct API mode (externalSource + externalId)", () => {
  async function makeApp() {
    const stores = makeStores();
    const { tenant, rawApiKey } = await stores.tenants.create("Direct Corp");
    const tmpl = await stores.templates.register(
      tenant.tenantId,
      "# Service Agreement\nStandard terms apply.",
      {},
    );
    await stores.requirements.upsert({
      tenantId: tenant.tenantId,
      templateHash: tmpl.hash,
      resource: "*",
      expiresIn: 3600,
      requiredPartyFields: ["name"],
    });
    const app = createFacilitatorApp({ ...stores, baseUrl: BASE_URL });
    return { app, tenant, tmpl, rawApiKey };
  }

  it("stores externalSource and externalId on the agreement record", async () => {
    const { app, tenant, tmpl, rawApiKey } = await makeApp();
    const res = await app.request(`/v1/${tenant.tenantId}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "x490:test",
        templateHash: tmpl.hash,
        partyData: { name: "Bob Corp" },
        externalSource: "salesforce",
        externalId: "CONTRACT-9999",
      }),
    });
    assert.equal(res.status, 200);
    const { contractId } = await res.json() as { contractId: string };

    // Retrieve via authed route
    const get = await app.request(`/v1/agreements/${contractId}`, {
      headers: { "X-API-Key": rawApiKey },
    });
    const record = await get.json() as { externalSource?: string; externalId?: string };
    assert.equal(record.externalSource, "salesforce");
    assert.equal(record.externalId, "CONTRACT-9999");
  });

  it("GET /v1/agreements/by-external finds the agreement by source and id", async () => {
    const { app, tenant, tmpl, rawApiKey } = await makeApp();
    await app.request(`/v1/${tenant.tenantId}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "x490:test",
        templateHash: tmpl.hash,
        partyData: { name: "Bob Corp" },
        externalSource: "salesforce",
        externalId: "CONTRACT-7777",
      }),
    });

    const res = await app.request(
      "/v1/agreements/by-external?source=salesforce&externalId=CONTRACT-7777",
      { headers: { "X-API-Key": rawApiKey } },
    );
    assert.equal(res.status, 200);
    const record = await res.json() as { externalSource?: string; externalId?: string };
    assert.equal(record.externalSource, "salesforce");
    assert.equal(record.externalId, "CONTRACT-7777");
  });

  it("GET /v1/agreements/by-external returns 404 for unknown external ID", async () => {
    const { app, rawApiKey } = await makeApp();
    const res = await app.request(
      "/v1/agreements/by-external?source=salesforce&externalId=DOES-NOT-EXIST",
      { headers: { "X-API-Key": rawApiKey } },
    );
    assert.equal(res.status, 404);
  });

  it("GET /v1/agreements/by-external returns 400 when params are missing", async () => {
    const { app, rawApiKey } = await makeApp();
    const res = await app.request(
      "/v1/agreements/by-external?source=salesforce",
      { headers: { "X-API-Key": rawApiKey } },
    );
    assert.equal(res.status, 400);
  });

  it("GET /v1/agreements/by-external requires authentication", async () => {
    const { app } = await makeApp();
    const res = await app.request(
      "/v1/agreements/by-external?source=salesforce&externalId=X",
    );
    assert.equal(res.status, 401);
  });
});
