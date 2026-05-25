import { describe, it, expect } from "vitest";
import { createFacilitatorApp } from "../app.js";
import {
  InMemoryTenantStore,
  InMemoryTemplateStore,
  InMemoryAgreementStore,
  InMemoryRequirementsStore,
  InMemoryWebhookStore,
} from "../store.js";
import type { AgreementRecord } from "../types.js";

async function makeApp() {
  const tenants = new InMemoryTenantStore();
  const templates = new InMemoryTemplateStore();
  const agreements = new InMemoryAgreementStore();
  const requirements = new InMemoryRequirementsStore();
  const webhooks = new InMemoryWebhookStore();

  const { tenant, rawApiKey } = await tenants.create("Acme");
  const tmpl = await templates.register(tenant.tenantId, "Pay {{amount}}", { title: "Payment" });

  const nowUnix = Math.floor(Date.now() / 1000);
  const agreement: AgreementRecord = {
    contractId: "c-001",
    tenantId: tenant.tenantId,
    templateHash: tmpl.hash,
    partyId: "agent-1",
    resource: "/api/payments",
    partyData: { amount: "100", currency: "USD" },
    token: "tok-original",
    issuedAt: nowUnix,
    expiresAt: nowUnix + 3600,
  };
  await agreements.record(agreement);

  const app = createFacilitatorApp({
    tenants,
    templates,
    agreements,
    requirements,
    webhooks,
    baseUrl: "http://localhost:3000",
  });

  return { app, tenant, rawApiKey, tmpl, agreements };
}

describe("POST /v1/agreements/:contractId/amend", () => {
  it("returns 404 for unknown contractId", async () => {
    const { app, rawApiKey } = await makeApp();
    const res = await app.request("/v1/agreements/nonexistent/amend", {
      method: "POST",
      headers: { "X-API-Key": rawApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ changes: { amount: "200" } }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when changes is missing", async () => {
    const { app, rawApiKey } = await makeApp();
    const res = await app.request("/v1/agreements/c-001/amend", {
      method: "POST",
      headers: { "X-API-Key": rawApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "no changes" }),
    });
    expect(res.status).toBe(400);
  });

  it("records an amendment and returns a new token", async () => {
    const { app, rawApiKey, agreements } = await makeApp();

    const res = await app.request("/v1/agreements/c-001/amend", {
      method: "POST",
      headers: { "X-API-Key": rawApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ changes: { amount: "200" }, reason: "price adjustment" }),
    });
    expect(res.status).toBe(200);

    const body = await res.json() as { amendment: { amendmentId: string; contractId: string; reason: string }; token: string };
    expect(body.amendment.contractId).toBe("c-001");
    expect(body.amendment.reason).toBe("price adjustment");
    expect(body.amendment.amendmentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof body.token).toBe("string");
    expect(body.token).not.toBe("tok-original");

    // amendment is persisted
    const list = await agreements.listAmendments("c-001");
    expect(list).toHaveLength(1);
    expect(list[0]!.changes).toEqual({ amount: "200" });
  });

  it("returns 409 when amending a revoked agreement", async () => {
    const { app, rawApiKey, agreements } = await makeApp();
    await agreements.revoke("c-001");

    const res = await app.request("/v1/agreements/c-001/amend", {
      method: "POST",
      headers: { "X-API-Key": rawApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ changes: { amount: "200" } }),
    });
    expect(res.status).toBe(409);
  });

  it("preserves previousToken in the amendment record", async () => {
    const { app, rawApiKey, agreements } = await makeApp();

    await app.request("/v1/agreements/c-001/amend", {
      method: "POST",
      headers: { "X-API-Key": rawApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ changes: { amount: "200" } }),
    });

    const list = await agreements.listAmendments("c-001");
    expect(list[0]!.previousToken).toBe("tok-original");
  });
});

describe("GET /v1/agreements/:contractId/amendments", () => {
  it("returns empty list for new agreement", async () => {
    const { app, rawApiKey } = await makeApp();
    const res = await app.request("/v1/agreements/c-001/amendments", {
      headers: { "X-API-Key": rawApiKey },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { amendments: unknown[] };
    expect(body.amendments).toHaveLength(0);
  });

  it("returns all amendments in order", async () => {
    const { app, rawApiKey } = await makeApp();

    await app.request("/v1/agreements/c-001/amend", {
      method: "POST",
      headers: { "X-API-Key": rawApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ changes: { amount: "200" } }),
    });
    await app.request("/v1/agreements/c-001/amend", {
      method: "POST",
      headers: { "X-API-Key": rawApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ changes: { amount: "300" } }),
    });

    const res = await app.request("/v1/agreements/c-001/amendments", {
      headers: { "X-API-Key": rawApiKey },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { amendments: Array<{ changes: Record<string, string> }> };
    expect(body.amendments).toHaveLength(2);
    expect(body.amendments[0]!.changes.amount).toBe("200");
    expect(body.amendments[1]!.changes.amount).toBe("300");
  });

  it("returns 404 for unknown contractId", async () => {
    const { app, rawApiKey } = await makeApp();
    const res = await app.request("/v1/agreements/unknown/amendments", {
      headers: { "X-API-Key": rawApiKey },
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/agreements/:contractId/renew", () => {
  it("creates a new agreement with parentContractId", async () => {
    const { app, rawApiKey, agreements } = await makeApp();

    const res = await app.request("/v1/agreements/c-001/renew", {
      method: "POST",
      headers: { "X-API-Key": rawApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: 86400 }),
    });
    expect(res.status).toBe(201);

    const body = await res.json() as { agreement: { contractId: string; parentContractId: string }; token: string };
    expect(body.agreement.parentContractId).toBe("c-001");
    expect(body.agreement.contractId).not.toBe("c-001");
    expect(typeof body.token).toBe("string");

    const stored = await agreements.findById(body.agreement.contractId);
    expect(stored?.parentContractId).toBe("c-001");
  });

  it("returns 404 for unknown contractId", async () => {
    const { app, rawApiKey } = await makeApp();
    const res = await app.request("/v1/agreements/nonexistent/renew", {
      method: "POST",
      headers: { "X-API-Key": rawApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 for revoked agreement", async () => {
    const { app, rawApiKey, agreements } = await makeApp();
    await agreements.revoke("c-001");

    const res = await app.request("/v1/agreements/c-001/renew", {
      method: "POST",
      headers: { "X-API-Key": rawApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
  });

  it("merges partyData overrides into the renewal", async () => {
    const { app, rawApiKey, agreements } = await makeApp();

    const res = await app.request("/v1/agreements/c-001/renew", {
      method: "POST",
      headers: { "X-API-Key": rawApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ partyData: { amount: "999" } }),
    });
    expect(res.status).toBe(201);

    const body = await res.json() as { agreement: { contractId: string; partyData: Record<string, string> } };
    const stored = await agreements.findById(body.agreement.contractId);
    expect(stored?.partyData.amount).toBe("999");
    expect(stored?.partyData.currency).toBe("USD"); // inherited
  });
});
