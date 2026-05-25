import { describe, it, expect } from "vitest";
import { createFacilitatorApp } from "../app.js";
import {
  InMemoryTenantStore,
  InMemoryTemplateStore,
  InMemoryAgreementStore,
  InMemoryRequirementsStore,
  InMemoryWebhookStore,
} from "../store.js";

async function makeApp() {
  const tenants = new InMemoryTenantStore();
  const templates = new InMemoryTemplateStore();
  const agreements = new InMemoryAgreementStore();
  const requirements = new InMemoryRequirementsStore();
  const webhooks = new InMemoryWebhookStore();

  const { tenant, rawApiKey } = await tenants.create("Acme");

  const app = createFacilitatorApp({
    tenants,
    templates,
    agreements,
    requirements,
    webhooks,
    baseUrl: "http://localhost:3000",
  });

  return { app, tenant, rawApiKey, templates };
}

describe("POST /v1/templates/:hash/supersede", () => {
  it("creates a child template with parentHash set", async () => {
    const { app, rawApiKey, templates } = await makeApp();

    // Register parent
    const parentRes = await app.request("/v1/templates", {
      method: "POST",
      headers: { "X-API-Key": rawApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Version 1: Pay {{amount}}", meta: { title: "v1" } }),
    });
    expect(parentRes.status).toBe(201);
    const parent = await parentRes.json() as { hash: string };

    // Supersede
    const res = await app.request(`/v1/templates/${parent.hash}/supersede`, {
      method: "POST",
      headers: { "X-API-Key": rawApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Version 2: Pay {{amount}} in {{currency}}",
        changeNote: "Added currency field",
      }),
    });
    expect(res.status).toBe(201);
    const child = await res.json() as { hash: string; parentHash: string; changeNote: string };
    expect(child.parentHash).toBe(parent.hash);
    expect(child.changeNote).toBe("Added currency field");
    expect(child.hash).not.toBe(parent.hash);
  });

  it("returns 404 for unknown parent hash", async () => {
    const { app, rawApiKey } = await makeApp();
    const res = await app.request("/v1/templates/deadbeef/supersede", {
      method: "POST",
      headers: { "X-API-Key": rawApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "new content" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when content is missing", async () => {
    const { app, rawApiKey } = await makeApp();

    const parentRes = await app.request("/v1/templates", {
      method: "POST",
      headers: { "X-API-Key": rawApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Version 1", meta: { title: "v1" } }),
    });
    const parent = await parentRes.json() as { hash: string };

    const res = await app.request(`/v1/templates/${parent.hash}/supersede`, {
      method: "POST",
      headers: { "X-API-Key": rawApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ changeNote: "no content" }),
    });
    expect(res.status).toBe(400);
  });

  it("inherits parent meta when not overridden", async () => {
    const { app, rawApiKey } = await makeApp();

    const parentRes = await app.request("/v1/templates", {
      method: "POST",
      headers: { "X-API-Key": rawApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Parent content", title: "My Contract" }),
    });
    const parent = await parentRes.json() as { hash: string; title: string };

    const childRes = await app.request(`/v1/templates/${parent.hash}/supersede`, {
      method: "POST",
      headers: { "X-API-Key": rawApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Updated content" }),
    });
    expect(childRes.status).toBe(201);
    const child = await childRes.json() as { meta: { title: string } };
    expect(child.meta.title).toBe("My Contract");
  });
});

describe("GET /v1/templates/:hash/history", () => {
  it("returns [self] for a root template", async () => {
    const { app, rawApiKey } = await makeApp();

    const parentRes = await app.request("/v1/templates", {
      method: "POST",
      headers: { "X-API-Key": rawApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Root template", meta: { title: "root" } }),
    });
    const parent = await parentRes.json() as { hash: string };

    const res = await app.request(`/v1/templates/${parent.hash}/history`, {
      headers: { "X-API-Key": rawApiKey },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { history: Array<{ hash: string }> };
    expect(body.history).toHaveLength(1);
    expect(body.history[0]!.hash).toBe(parent.hash);
  });

  it("returns ancestor chain from oldest to newest", async () => {
    const { app, rawApiKey } = await makeApp();

    const v1Res = await app.request("/v1/templates", {
      method: "POST",
      headers: { "X-API-Key": rawApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Version 1", meta: { title: "v1" } }),
    });
    const v1 = await v1Res.json() as { hash: string };

    const v2Res = await app.request(`/v1/templates/${v1.hash}/supersede`, {
      method: "POST",
      headers: { "X-API-Key": rawApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Version 2" }),
    });
    const v2 = await v2Res.json() as { hash: string };

    const v3Res = await app.request(`/v1/templates/${v2.hash}/supersede`, {
      method: "POST",
      headers: { "X-API-Key": rawApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Version 3" }),
    });
    const v3 = await v3Res.json() as { hash: string };

    const res = await app.request(`/v1/templates/${v3.hash}/history`, {
      headers: { "X-API-Key": rawApiKey },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { history: Array<{ hash: string }> };
    expect(body.history).toHaveLength(3);
    expect(body.history[0]!.hash).toBe(v1.hash);
    expect(body.history[1]!.hash).toBe(v2.hash);
    expect(body.history[2]!.hash).toBe(v3.hash);
  });

  it("returns 404 for unknown template hash", async () => {
    const { app, rawApiKey } = await makeApp();
    const res = await app.request("/v1/templates/unknown/history", {
      headers: { "X-API-Key": rawApiKey },
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/templates/:hash/children", () => {
  it("returns empty for a template with no children", async () => {
    const { app, rawApiKey } = await makeApp();

    const parentRes = await app.request("/v1/templates", {
      method: "POST",
      headers: { "X-API-Key": rawApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Leaf", meta: { title: "leaf" } }),
    });
    const parent = await parentRes.json() as { hash: string };

    const res = await app.request(`/v1/templates/${parent.hash}/children`, {
      headers: { "X-API-Key": rawApiKey },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { children: unknown[] };
    expect(body.children).toHaveLength(0);
  });

  it("returns direct child versions", async () => {
    const { app, rawApiKey } = await makeApp();

    const parentRes = await app.request("/v1/templates", {
      method: "POST",
      headers: { "X-API-Key": rawApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Parent", meta: { title: "parent" } }),
    });
    const parent = await parentRes.json() as { hash: string };

    await app.request(`/v1/templates/${parent.hash}/supersede`, {
      method: "POST",
      headers: { "X-API-Key": rawApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Child A" }),
    });
    await app.request(`/v1/templates/${parent.hash}/supersede`, {
      method: "POST",
      headers: { "X-API-Key": rawApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Child B" }),
    });

    const res = await app.request(`/v1/templates/${parent.hash}/children`, {
      headers: { "X-API-Key": rawApiKey },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { children: Array<{ parentHash: string }> };
    expect(body.children).toHaveLength(2);
    expect(body.children.every((c) => c.parentHash === parent.hash)).toBe(true);
  });

  it("returns 404 for unknown template hash", async () => {
    const { app, rawApiKey } = await makeApp();
    const res = await app.request("/v1/templates/unknown/children", {
      headers: { "X-API-Key": rawApiKey },
    });
    expect(res.status).toBe(404);
  });
});
