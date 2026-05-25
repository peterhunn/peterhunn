import { describe, it, expect } from "vitest";
import { extractDocumentText, isSupportedMimeType, SUPPORTED_MIME_TYPES } from "../document-extractor.js";
import { createFacilitatorApp } from "../app.js";
import {
  InMemoryTenantStore,
  InMemoryTemplateStore,
  InMemoryAgreementStore,
  InMemoryRequirementsStore,
  InMemoryWebhookStore,
} from "../store.js";

describe("isSupportedMimeType", () => {
  it("accepts all declared MIME types", () => {
    for (const mime of SUPPORTED_MIME_TYPES) {
      expect(isSupportedMimeType(mime)).toBe(true);
    }
  });

  it("rejects unsupported types", () => {
    expect(isSupportedMimeType("image/png")).toBe(false);
    expect(isSupportedMimeType("application/msword")).toBe(false);
  });
});

describe("extractDocumentText — plain text", () => {
  it("extracts text/plain content directly", async () => {
    const content = "This is a contract: {{amount}} USD for {{service}}.";
    const bytes = new TextEncoder().encode(content);
    const result = await extractDocumentText(bytes, "text/plain");
    expect(result.text).toBe(content);
    expect(result.format).toBe("text");
    expect(result.warnings).toHaveLength(0);
  });

  it("extracts text/markdown content", async () => {
    const content = "# Agreement\n\nPay **{{amount}}** for {{service}}.";
    const bytes = new TextEncoder().encode(content);
    const result = await extractDocumentText(bytes, "text/markdown");
    expect(result.text).toBe(content);
    expect(result.format).toBe("text");
  });
});

describe("extractDocumentText — unsupported types", () => {
  it("throws for unsupported MIME types", async () => {
    const bytes = new Uint8Array([0, 1, 2]);
    await expect(extractDocumentText(bytes, "image/png")).rejects.toThrow("Unsupported document type");
  });
});

describe("POST /v1/templates/upload", () => {
  async function makeApp() {
    const tenants = new InMemoryTenantStore();
    const templates = new InMemoryTemplateStore();
    const agreements = new InMemoryAgreementStore();
    const requirements = new InMemoryRequirementsStore();
    const webhooks = new InMemoryWebhookStore();
    const { rawApiKey } = await tenants.create("Acme");
    const app = createFacilitatorApp({ tenants, templates, agreements, requirements, webhooks, baseUrl: "http://localhost:3000" });
    return { app, rawApiKey, templates };
  }

  function makeFormData(content: string, mimeType: string, title?: string): FormData {
    const formData = new FormData();
    const blob = new Blob([content], { type: mimeType });
    formData.set("file", blob, "contract.txt");
    if (title) formData.set("title", title);
    return formData;
  }

  it("registers a plain text file as a template", async () => {
    const { app, rawApiKey } = await makeApp();
    const formData = makeFormData("Pay {{amount}} for {{service}}.", "text/plain", "Service Contract");

    const res = await app.request("/v1/templates/upload", {
      method: "POST",
      headers: { "X-API-Key": rawApiKey },
      body: formData,
    });

    expect(res.status).toBe(201);
    const body = await res.json() as { hash: string; format: string; title: string };
    expect(body.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.format).toBe("text");
    expect(body.title).toBe("Service Contract");
  });

  it("returns 415 for unsupported MIME types", async () => {
    const { app, rawApiKey } = await makeApp();
    const formData = new FormData();
    formData.set("file", new Blob(["data"], { type: "image/png" }), "img.png");

    const res = await app.request("/v1/templates/upload", {
      method: "POST",
      headers: { "X-API-Key": rawApiKey },
      body: formData,
    });

    expect(res.status).toBe(415);
  });

  it("returns 400 when no file is provided", async () => {
    const { app, rawApiKey } = await makeApp();
    const formData = new FormData();
    formData.set("title", "No file");

    const res = await app.request("/v1/templates/upload", {
      method: "POST",
      headers: { "X-API-Key": rawApiKey },
      body: formData,
    });

    expect(res.status).toBe(400);
  });

  it("links to parent template via parentHash", async () => {
    const { app, rawApiKey, templates } = await makeApp();

    // Register parent
    const v1 = makeFormData("Version 1: Pay {{amount}}.", "text/plain", "v1");
    const r1 = await app.request("/v1/templates/upload", {
      method: "POST",
      headers: { "X-API-Key": rawApiKey },
      body: v1,
    });
    const p1 = await r1.json() as { hash: string };

    // Upload v2 as successor
    const v2 = makeFormData("Version 2: Pay {{amount}} plus {{tax}}.", "text/plain");
    v2.set("parentHash", p1.hash);
    v2.set("changeNote", "Added tax field");

    const r2 = await app.request("/v1/templates/upload", {
      method: "POST",
      headers: { "X-API-Key": rawApiKey },
      body: v2,
    });
    expect(r2.status).toBe(201);
    const p2 = await r2.json() as { hash: string; parentHash: string };
    expect(p2.parentHash).toBe(p1.hash);

    // Verify in store
    const stored = await templates.findByHash(p2.hash);
    expect(stored?.parentHash).toBe(p1.hash);
    expect(stored?.changeNote).toBe("Added tax field");
  });

  it("requires API key authentication", async () => {
    const { app } = await makeApp();
    const formData = makeFormData("content", "text/plain");
    const res = await app.request("/v1/templates/upload", { method: "POST", body: formData });
    expect(res.status).toBe(401);
  });
});
