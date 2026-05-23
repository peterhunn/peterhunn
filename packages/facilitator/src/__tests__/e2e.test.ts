/**
 * End-to-end tests: ContractClient against a real in-process createFacilitatorApp.
 *
 * globalThis.fetch is patched so facilitator calls route to app.request() and
 * resource calls go to a per-test handler. Accept counts are verified via the
 * in-memory agreements store to avoid fetch-routing order issues.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Hono } from "hono";
import { ContractClient } from "@x490/protocol";
import {
  InMemoryTenantStore,
  InMemoryTemplateStore,
  InMemoryRequirementsStore,
  InMemoryAgreementStore,
  InMemoryWebhookStore,
  InMemoryEventStore,
  InMemoryPendingContractStore,
  InMemoryWebhookDeliveryStore,
} from "../store.js";
import { createFacilitatorApp } from "../app.js";

const BASE_URL = "https://facilitator.e2e.test";
const RESOURCE_URL = "https://resource.e2e.test/data";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

let restoreFetch: (() => void) | null = null;

afterEach(() => { restoreFetch?.(); restoreFetch = null; });

function makeApp() {
  const stores = {
    tenants: new InMemoryTenantStore(),
    templates: new InMemoryTemplateStore(),
    requirements: new InMemoryRequirementsStore(),
    agreements: new InMemoryAgreementStore(),
    webhooks: new InMemoryWebhookStore(),
    events: new InMemoryEventStore(),
    pendingContracts: new InMemoryPendingContractStore(),
    deliveries: new InMemoryWebhookDeliveryStore(),
  };
  return { app: createFacilitatorApp({ ...stores, baseUrl: BASE_URL }), ...stores };
}

function b64encode(str: string): string {
  return Buffer.from(str).toString("base64");
}

function patchFetch(app: Hono, resourceHandler: (headers: Headers) => Response | Promise<Response>) {
  const original = globalThis.fetch as FetchLike;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url.startsWith(BASE_URL)) return app.request(url.slice(BASE_URL.length) || "/", init as RequestInit);
    if (url === RESOURCE_URL) return resourceHandler(new Headers(init?.headers));
    return original(input, init);
  };
  restoreFetch = () => { globalThis.fetch = original as typeof fetch; };
}

async function bootstrap(app: Hono, opts: { expiresIn?: number } = {}) {
  const { tenantId, apiKey } = await app.request("/v1/tenants", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "E2E Tenant" }),
  }).then((r) => r.json() as Promise<{ tenantId: string; apiKey: string }>);

  const { hash: templateHash } = await app.request("/v1/templates", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify({ content: "E2E NDA: {{name}}", title: "E2E NDA" }),
  }).then((r) => r.json() as Promise<{ hash: string }>);

  const reqs = await app.request("/v1/requirements", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify({
      templateHash, requiredPartyFields: ["name"], resource: "*",
      description: "E2E", expiresIn: opts.expiresIn ?? 3600,
    }),
  }).then((r) => r.json() as Promise<Record<string, unknown>>);

  return { tenantId, apiKey, templateHash, reqs };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("e2e: ContractClient against in-process facilitator", () => {
  it("full contract flow — 490 triggers accept, retry succeeds with 200", async () => {
    const { app, agreements } = makeApp();
    const { tenantId, reqs } = await bootstrap(app);
    const reqHeader = b64encode(JSON.stringify(reqs));
    let resourceCalls = 0;

    patchFetch(app, (headers) => {
      resourceCalls++;
      if (!headers.get("X-490-Contract"))
        return new Response(null, { status: 490, headers: { "X-490-Requirements": reqHeader } });
      return new Response(JSON.stringify({ data: "protected" }), { status: 200 });
    });

    const client = new ContractClient({ partyData: { name: "Alice" }, skipTemplateVerification: true });
    const res = await client.fetch(RESOURCE_URL);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(resourceCalls, 2, "resource hit twice: 490 then 200");
    const { agreements: list } = await agreements.listByTenant(tenantId, { limit: 10 });
    assert.strictEqual(list.length, 1, "one agreement recorded");
  });

  it("token is cached — second fetch reuses cached token, accept called only once", async () => {
    const { app, agreements } = makeApp();
    const { tenantId, reqs } = await bootstrap(app);
    const reqHeader = b64encode(JSON.stringify(reqs));

    patchFetch(app, (headers) => {
      if (!headers.get("X-490-Contract"))
        return new Response(null, { status: 490, headers: { "X-490-Requirements": reqHeader } });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const client = new ContractClient({ partyData: { name: "Alice" }, skipTemplateVerification: true });
    assert.strictEqual((await client.fetch(RESOURCE_URL)).status, 200);
    assert.strictEqual((await client.fetch(RESOURCE_URL)).status, 200);

    const { agreements: list } = await agreements.listByTenant(tenantId, { limit: 10 });
    assert.strictEqual(list.length, 1, "cached token should prevent second accept");
  });

  it("tokenRefreshThreshold — near-expiry token triggers re-acceptance", async () => {
    const { app, agreements } = makeApp();
    // expiresIn 61 s; threshold set to 62 → token always treated as near-expiry
    const { tenantId, reqs } = await bootstrap(app, { expiresIn: 61 });
    const reqHeader = b64encode(JSON.stringify(reqs));

    patchFetch(app, (headers) => {
      if (!headers.get("X-490-Contract"))
        return new Response(null, { status: 490, headers: { "X-490-Requirements": reqHeader } });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const client = new ContractClient({
      partyData: { name: "Alice" }, skipTemplateVerification: true, tokenRefreshThreshold: 62,
    });

    assert.strictEqual((await client.fetch(RESOURCE_URL)).status, 200); // accept #1
    assert.strictEqual((await client.fetch(RESOURCE_URL)).status, 200); // threshold > TTL → accept #2

    const { agreements: list } = await agreements.listByTenant(tenantId, { limit: 10 });
    assert.strictEqual(list.length, 2, "near-expiry threshold should trigger a second accept");
  });
});
