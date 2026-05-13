import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../app.js";
import { InMemoryStore } from "../store.js";
import { InMemoryApiKeyStore } from "../auth.js";
import { MerkleAuditLog } from "../audit.js";
import { InMemoryWebhookStore } from "../webhooks.js";
import { ContractRegistry } from "../registry.js";
import { initialState } from "@x490/core";
import type {
  ContractData,
  ContractModel,
  ContractTemplate,
  ContractLogic,
  ContractState,
} from "@x490/core";
import type { LLMClient } from "@x490/agents";

// ── Mock LLM ──────────────────────────────────────────────────────────────────

/**
 * Returns predictable JSON so ContractAgent LLM methods succeed.
 * analyze / compliance / negotiate each parse JSON from result.content.
 */
const mockLlm: LLMClient = {
  async complete(_systemPrompt, _messages, _tools) {
    return {
      content: JSON.stringify({
        // analyze
        summary: "Test NDA summary",
        parties: [{ name: "Acme", role: "Disclosing Party" }],
        obligations: [],
        risks: [],
        missingClauses: [],
        // compliance
        passed: true,
        results: [],
        // negotiate — also serves as an array for negotiate()
      }),
      stopReason: "end_turn",
    };
  },
};

/**
 * negotiate() expects a JSON array from the LLM response.
 * We return an array-shaped JSON so parse works for both uses.
 * However, JSON.parse of the object above will fail for negotiate because it expects an array.
 * We use a second mock that returns an array for tests that call negotiate.
 */
const mockLlmNegotiate: LLMClient = {
  async complete(_systemPrompt, _messages, _tools) {
    return {
      content: JSON.stringify([
        { clause: "Section 1", issue: "Overly broad", suggestion: "Narrow the scope", priority: "high" },
      ]),
      stopReason: "end_turn",
    };
  },
};

// ── Minimal NDA contract stubs ────────────────────────────────────────────────

type NdaData = ContractData & { name: string };

const ndaModel: ContractModel<NdaData> = {
  meta: { namespace: "test.nda", name: "NDAContract", version: "1.0.0" },
  is(data): data is NdaData {
    return typeof data === "object" && data !== null;
  },
  serialize(data) {
    return JSON.stringify(data);
  },
  deserialize(json) {
    return JSON.parse(json) as NdaData;
  },
};

const ndaTemplate: ContractTemplate<NdaData> = {
  model: ndaModel,
  text: "NDA between {{name}}",
  draft(_data) {
    return "Contract text";
  },
  parse(_text) {
    return {};
  },
  variables() {
    return ["name"];
  },
};

const ndaLogic: ContractLogic<NdaData> = {
  init(_data): ContractState {
    return initialState({ status: "active" });
  },
  execute(_event, ctx) {
    return { state: ctx.state, result: "ok" };
  },
};

// ── Factory helpers ───────────────────────────────────────────────────────────

function makeRegistry() {
  const registry = new ContractRegistry();
  registry.register("nda", { model: ndaModel, template: ndaTemplate, logic: ndaLogic });
  return registry;
}

function makeApp(llm: LLMClient = mockLlm) {
  const store = new InMemoryStore();
  const apiKeys = new InMemoryApiKeyStore();
  const audit = new MerkleAuditLog();
  const webhooks = new InMemoryWebhookStore();
  const registry = makeRegistry();
  const app = createApp({ registry, store, llm, apiKeys, audit, webhooks });
  return { app, store, apiKeys, audit, webhooks, registry };
}

/**
 * Bootstrap a live API key for "org-1" and return the raw token string.
 */
async function bootstrap(
  apiKeys: InMemoryApiKeyStore,
  opts: { orgId?: string; mode?: "live" | "test" } = {},
): Promise<{ raw: string; orgId: string; keyId: string }> {
  const orgId = opts.orgId ?? "org-1";
  const { key, raw } = await apiKeys.create(orgId, "default", opts.mode ?? "live");
  return { raw, orgId, keyId: key.id };
}

function authHeader(raw: string) {
  return { Authorization: `Bearer ${raw}` };
}

function jsonHeaders(raw: string) {
  return { ...authHeader(raw), "Content-Type": "application/json" };
}

// ── Auth ──────────────────────────────────────────────────────────────────────

describe("Auth", () => {
  it("No Authorization header → 401", async () => {
    const { app } = makeApp();
    const res = await app.request("/contracts");
    assert.equal(res.status, 401);
    const body = await res.json() as { error: string };
    assert.ok(body.error.includes("Authorization"));
  });

  it("Invalid key → 401", async () => {
    const { app } = makeApp();
    const res = await app.request("/contracts", {
      headers: { Authorization: "Bearer sk_live_notarealkey" },
    });
    assert.equal(res.status, 401);
    const body = await res.json() as { error: string };
    assert.ok(body.error.includes("Invalid") || body.error.includes("revoked"));
  });

  it("Valid key → request proceeds (200)", async () => {
    const { app, apiKeys } = makeApp();
    const { raw } = await bootstrap(apiKeys);
    const res = await app.request("/contracts", { headers: authHeader(raw) });
    assert.equal(res.status, 200);
  });
});

// ── API key management ────────────────────────────────────────────────────────

describe("API key management", () => {
  it("POST /keys → 201, returns { key, raw } with raw starting sk_live_", async () => {
    const { app, apiKeys } = makeApp();
    const { raw } = await bootstrap(apiKeys);
    const res = await app.request("/keys", {
      method: "POST",
      headers: jsonHeaders(raw),
      body: JSON.stringify({ name: "second-key" }),
    });
    assert.equal(res.status, 201);
    const body = await res.json() as { key: { id: string; name: string }; raw: string };
    assert.ok(body.raw.startsWith("sk_live_"), `expected sk_live_ prefix, got ${body.raw}`);
    assert.ok(body.key.id.length > 0);
  });

  it("POST /keys with mode:'test' → raw starts sk_test_", async () => {
    const { app, apiKeys } = makeApp();
    const { raw } = await bootstrap(apiKeys);
    const res = await app.request("/keys", {
      method: "POST",
      headers: jsonHeaders(raw),
      body: JSON.stringify({ name: "test-key", mode: "test" }),
    });
    assert.equal(res.status, 201);
    const body = await res.json() as { key: unknown; raw: string };
    assert.ok(body.raw.startsWith("sk_test_"), `expected sk_test_ prefix, got ${body.raw}`);
  });

  it("GET /keys → 200, lists active keys", async () => {
    const { app, apiKeys } = makeApp();
    const { raw } = await bootstrap(apiKeys);
    const res = await app.request("/keys", { headers: authHeader(raw) });
    assert.equal(res.status, 200);
    const body = await res.json() as { keys: Array<{ id: string; name: string }> };
    assert.ok(Array.isArray(body.keys));
    assert.equal(body.keys.length, 1);
  });

  it("key hash not present in GET /keys response", async () => {
    const { app, apiKeys } = makeApp();
    const { raw } = await bootstrap(apiKeys);
    const res = await app.request("/keys", { headers: authHeader(raw) });
    const body = await res.json() as { keys: Array<Record<string, unknown>> };
    for (const k of body.keys) {
      assert.ok(!("keyHash" in k), "keyHash must not be exposed");
    }
  });

  it("DELETE /keys/:id → 200, key no longer returned in list", async () => {
    const { app, apiKeys } = makeApp();
    // Create two keys so we don't lock ourselves out after deleting one
    const { raw: raw1, keyId: keyId1 } = await bootstrap(apiKeys, { orgId: "org-del" });
    const { raw: raw2 } = await bootstrap(apiKeys, { orgId: "org-del" });

    const delRes = await app.request(`/keys/${keyId1}`, {
      method: "DELETE",
      headers: authHeader(raw2),
    });
    assert.equal(delRes.status, 200);
    const delBody = await delRes.json() as { revoked: boolean };
    assert.equal(delBody.revoked, true);

    // List with second key — first key should be gone
    const listRes = await app.request("/keys", { headers: authHeader(raw2) });
    const listBody = await listRes.json() as { keys: Array<{ id: string }> };
    const ids = listBody.keys.map((k) => k.id);
    assert.ok(!ids.includes(keyId1), "revoked key should not appear in list");
  });
});

// ── Webhook management ────────────────────────────────────────────────────────

describe("Webhook management", () => {
  it("POST /webhooks → 201, returns webhook with secret", async () => {
    const { app, apiKeys } = makeApp();
    const { raw } = await bootstrap(apiKeys);
    const res = await app.request("/webhooks", {
      method: "POST",
      headers: jsonHeaders(raw),
      body: JSON.stringify({ url: "https://example.com/hook", events: ["contract.activated"] }),
    });
    assert.equal(res.status, 201);
    const body = await res.json() as { webhook: { id: string; secret: string; url: string } };
    assert.ok(body.webhook.id.length > 0);
    assert.ok(body.webhook.secret.length > 0, "secret must be returned once on creation");
    assert.equal(body.webhook.url, "https://example.com/hook");
  });

  it("GET /webhooks → 200, secret not in response", async () => {
    const { app, apiKeys } = makeApp();
    const { raw } = await bootstrap(apiKeys);
    // Create a webhook first
    await app.request("/webhooks", {
      method: "POST",
      headers: jsonHeaders(raw),
      body: JSON.stringify({ url: "https://example.com/hook", events: ["contract.activated"] }),
    });
    const res = await app.request("/webhooks", { headers: authHeader(raw) });
    assert.equal(res.status, 200);
    const body = await res.json() as { webhooks: Array<Record<string, unknown>> };
    assert.ok(Array.isArray(body.webhooks));
    assert.equal(body.webhooks.length, 1);
    for (const h of body.webhooks) {
      assert.ok(!("secret" in h), "secret must not be exposed in list");
    }
  });

  it("DELETE /webhooks/:id → 200", async () => {
    const { app, apiKeys } = makeApp();
    const { raw } = await bootstrap(apiKeys);
    const createRes = await app.request("/webhooks", {
      method: "POST",
      headers: jsonHeaders(raw),
      body: JSON.stringify({ url: "https://example.com/hook", events: ["contract.activated"] }),
    });
    const { webhook } = await createRes.json() as { webhook: { id: string } };

    const delRes = await app.request(`/webhooks/${webhook.id}`, {
      method: "DELETE",
      headers: authHeader(raw),
    });
    assert.equal(delRes.status, 200);
    const delBody = await delRes.json() as { deleted: boolean };
    assert.equal(delBody.deleted, true);
  });

  it("DELETE /webhooks/:id for another org → 404", async () => {
    const { app, apiKeys } = makeApp();
    const { raw: rawOrg1 } = await bootstrap(apiKeys, { orgId: "org-wh-1" });
    const { raw: rawOrg2 } = await bootstrap(apiKeys, { orgId: "org-wh-2" });

    // Org 1 creates a webhook
    const createRes = await app.request("/webhooks", {
      method: "POST",
      headers: jsonHeaders(rawOrg1),
      body: JSON.stringify({ url: "https://example.com/hook", events: ["contract.activated"] }),
    });
    const { webhook } = await createRes.json() as { webhook: { id: string } };

    // Org 2 tries to delete it
    const delRes = await app.request(`/webhooks/${webhook.id}`, {
      method: "DELETE",
      headers: authHeader(rawOrg2),
    });
    assert.equal(delRes.status, 404);
  });
});

// ── Contract discovery ────────────────────────────────────────────────────────

describe("Contract discovery", () => {
  it("GET /contracts → 200, returns { types: ['nda'] }", async () => {
    const { app, apiKeys } = makeApp();
    const { raw } = await bootstrap(apiKeys);
    const res = await app.request("/contracts", { headers: authHeader(raw) });
    assert.equal(res.status, 200);
    const body = await res.json() as { types: string[] };
    assert.ok(Array.isArray(body.types));
    assert.ok(body.types.includes("nda"));
  });
});

// ── Type operations ───────────────────────────────────────────────────────────

describe("Type operations", () => {
  it("POST /contracts/nda/draft → 200 with { text }", async () => {
    const { app, apiKeys } = makeApp();
    const { raw } = await bootstrap(apiKeys);
    const res = await app.request("/contracts/nda/draft", {
      method: "POST",
      headers: jsonHeaders(raw),
      body: JSON.stringify({ data: { $class: "test.nda.NDAContract", name: "Acme" } }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { text: string };
    assert.ok(typeof body.text === "string" && body.text.length > 0);
  });

  it("POST /contracts/unknown/draft → 404", async () => {
    const { app, apiKeys } = makeApp();
    const { raw } = await bootstrap(apiKeys);
    const res = await app.request("/contracts/unknown/draft", {
      method: "POST",
      headers: jsonHeaders(raw),
      body: JSON.stringify({ data: { $class: "x", name: "y" } }),
    });
    assert.equal(res.status, 404);
    const body = await res.json() as { error: string };
    assert.ok(body.error.includes("unknown"));
  });

  it("POST /contracts/nda/parse → 200", async () => {
    const { app, apiKeys } = makeApp();
    const { raw } = await bootstrap(apiKeys);
    const res = await app.request("/contracts/nda/parse", {
      method: "POST",
      headers: jsonHeaders(raw),
      body: JSON.stringify({ text: "Contract text for Acme" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { data: unknown };
    assert.ok("data" in body);
  });

  it("POST /contracts/nda/analyze → 200", async () => {
    const { app, apiKeys } = makeApp();
    const { raw } = await bootstrap(apiKeys);
    const res = await app.request("/contracts/nda/analyze", {
      method: "POST",
      headers: jsonHeaders(raw),
      body: JSON.stringify({ text: "Contract text" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { summary: string };
    assert.ok(typeof body.summary === "string");
  });

  it("POST /contracts/nda/negotiate → 200", async () => {
    const { app, apiKeys } = makeApp(mockLlmNegotiate);
    const { raw } = await bootstrap(apiKeys);
    const res = await app.request("/contracts/nda/negotiate", {
      method: "POST",
      headers: jsonHeaders(raw),
      body: JSON.stringify({ text: "Contract text", perspective: "neutral" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { suggestions: unknown[] };
    assert.ok(Array.isArray(body.suggestions));
  });
});

// ── Instance operations ───────────────────────────────────────────────────────

describe("Instance operations", () => {
  it("POST /contracts/nda/activate → 201 with { contractId, state }", async () => {
    const { app, apiKeys } = makeApp();
    const { raw } = await bootstrap(apiKeys);
    const res = await app.request("/contracts/nda/activate", {
      method: "POST",
      headers: jsonHeaders(raw),
      body: JSON.stringify({ data: { $class: "test.nda.NDAContract", name: "Acme" } }),
    });
    assert.equal(res.status, 201);
    const body = await res.json() as { contractId: string; state: { stateId: string; status: string } };
    assert.ok(body.contractId.length > 0);
    assert.ok(body.state.stateId.length > 0);
    assert.equal(body.state.status, "active");
  });

  it("GET /contracts/:contractId/state → 200", async () => {
    const { app, apiKeys } = makeApp();
    const { raw } = await bootstrap(apiKeys);

    const activateRes = await app.request("/contracts/nda/activate", {
      method: "POST",
      headers: jsonHeaders(raw),
      body: JSON.stringify({ data: { $class: "test.nda.NDAContract", name: "Acme" } }),
    });
    const { contractId } = await activateRes.json() as { contractId: string };

    const stateRes = await app.request(`/contracts/${contractId}/state`, {
      headers: authHeader(raw),
    });
    assert.equal(stateRes.status, 200);
    const body = await stateRes.json() as { contractId: string; contractType: string; state: unknown };
    assert.equal(body.contractId, contractId);
    assert.equal(body.contractType, "nda");
    assert.ok(body.state !== undefined);
  });

  it("GET /contracts/:contractId/state (wrong org) → 404", async () => {
    const { app, apiKeys } = makeApp();
    const { raw: rawOrg1 } = await bootstrap(apiKeys, { orgId: "org-state-1" });
    const { raw: rawOrg2 } = await bootstrap(apiKeys, { orgId: "org-state-2" });

    const activateRes = await app.request("/contracts/nda/activate", {
      method: "POST",
      headers: jsonHeaders(rawOrg1),
      body: JSON.stringify({ data: { $class: "test.nda.NDAContract", name: "Acme" } }),
    });
    const { contractId } = await activateRes.json() as { contractId: string };

    const stateRes = await app.request(`/contracts/${contractId}/state`, {
      headers: authHeader(rawOrg2),
    });
    assert.equal(stateRes.status, 404);
  });

  it("POST /contracts/:contractId/events → 200 with { state, result }", async () => {
    const { app, apiKeys } = makeApp();
    const { raw } = await bootstrap(apiKeys);

    const activateRes = await app.request("/contracts/nda/activate", {
      method: "POST",
      headers: jsonHeaders(raw),
      body: JSON.stringify({ data: { $class: "test.nda.NDAContract", name: "Acme" } }),
    });
    const { contractId } = await activateRes.json() as { contractId: string };

    const evtRes = await app.request(`/contracts/${contractId}/events`, {
      method: "POST",
      headers: jsonHeaders(raw),
      body: JSON.stringify({ eventType: "SIGN", party: "party-1", payload: {} }),
    });
    assert.equal(evtRes.status, 200);
    const body = await evtRes.json() as { state: unknown; result: unknown };
    assert.ok(body.state !== undefined);
    assert.ok(body.result !== undefined);
  });

  it("GET /contracts/:contractId/audit → 200, has entries", async () => {
    const { app, apiKeys } = makeApp();
    const { raw } = await bootstrap(apiKeys);

    const activateRes = await app.request("/contracts/nda/activate", {
      method: "POST",
      headers: jsonHeaders(raw),
      body: JSON.stringify({ data: { $class: "test.nda.NDAContract", name: "Acme" } }),
    });
    const { contractId } = await activateRes.json() as { contractId: string };

    const auditRes = await app.request(`/contracts/${contractId}/audit`, {
      headers: authHeader(raw),
    });
    assert.equal(auditRes.status, 200);
    const body = await auditRes.json() as { contractId: string; entries: unknown[] };
    assert.equal(body.contractId, contractId);
    assert.ok(body.entries.length > 0, "should have at least one audit entry from activation");
  });

  it("GET /contracts/:contractId/audit/verify → 200, { valid: true }", async () => {
    const { app, apiKeys } = makeApp();
    const { raw } = await bootstrap(apiKeys);

    const activateRes = await app.request("/contracts/nda/activate", {
      method: "POST",
      headers: jsonHeaders(raw),
      body: JSON.stringify({ data: { $class: "test.nda.NDAContract", name: "Acme" } }),
    });
    const { contractId } = await activateRes.json() as { contractId: string };

    const verifyRes = await app.request(`/contracts/${contractId}/audit/verify`, {
      headers: authHeader(raw),
    });
    assert.equal(verifyRes.status, 200);
    const body = await verifyRes.json() as { valid: boolean };
    assert.equal(body.valid, true);
  });

  it("POST /contracts/nda/activate with bad data → 400", async () => {
    // Build an app with a strict model that rejects non-objects / missing fields.
    const badRegistry = new ContractRegistry();
    const strictModel: ContractModel<NdaData> = {
      ...ndaModel,
      is(data): data is NdaData {
        return (
          typeof data === "object" &&
          data !== null &&
          "$class" in (data as object) &&
          "name" in (data as object)
        );
      },
    };
    badRegistry.register("nda", { model: strictModel, template: ndaTemplate, logic: ndaLogic });

    const strictStore = new InMemoryStore();
    const strictApiKeys = new InMemoryApiKeyStore();
    const strictAudit = new MerkleAuditLog();
    const strictWebhooks = new InMemoryWebhookStore();
    const strictApp = createApp({
      registry: badRegistry,
      store: strictStore,
      llm: mockLlm,
      apiKeys: strictApiKeys,
      audit: strictAudit,
      webhooks: strictWebhooks,
    });
    const { raw } = await bootstrap(strictApiKeys);

    const res = await strictApp.request("/contracts/nda/activate", {
      method: "POST",
      headers: jsonHeaders(raw),
      body: JSON.stringify({ data: "not-an-object" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.ok(body.error.includes("model"));
  });

  it("Cross-org: can't GET state of another org's contract", async () => {
    const { app, apiKeys } = makeApp();
    const { raw: rawA } = await bootstrap(apiKeys, { orgId: "org-cross-a" });
    const { raw: rawB } = await bootstrap(apiKeys, { orgId: "org-cross-b" });

    // Org A activates a contract
    const activateRes = await app.request("/contracts/nda/activate", {
      method: "POST",
      headers: jsonHeaders(rawA),
      body: JSON.stringify({ data: { $class: "test.nda.NDAContract", name: "Acme" } }),
    });
    assert.equal(activateRes.status, 201);
    const { contractId } = await activateRes.json() as { contractId: string };

    // Org B tries to read it
    const stateRes = await app.request(`/contracts/${contractId}/state`, {
      headers: authHeader(rawB),
    });
    assert.equal(stateRes.status, 404);
  });
});
