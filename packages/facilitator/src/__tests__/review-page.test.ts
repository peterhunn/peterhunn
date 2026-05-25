import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFacilitatorApp } from "../app.js";
import {
  InMemoryTenantStore,
  InMemoryTemplateStore,
  InMemoryAgreementStore,
  InMemoryRequirementsStore,
  InMemoryWebhookStore,
} from "../store.js";
import { renderReviewPage } from "../review-page.js";

const BASE_URL = "https://facilitator.example.com";

const MARKED_TEMPLATE = [
  "# Software License Agreement",
  "",
  "**License Fee**: <!-- clause:licenseFee -->$50,000<!-- /clause:licenseFee -->",
  "",
  "**Term**: <!-- clause:termMonths -->12 months<!-- /clause:termMonths -->",
  "",
  "Standard terms apply.",
].join("\n");

function makeStores() {
  return {
    tenants: new InMemoryTenantStore(),
    templates: new InMemoryTemplateStore(),
    agreements: new InMemoryAgreementStore(),
    requirements: new InMemoryRequirementsStore(),
    webhooks: new InMemoryWebhookStore(),
  };
}

// ── renderReviewPage unit tests ───────────────────────────────────────────────

describe("renderReviewPage", () => {
  const fakeTenant = { tenantId: "t1", hmacSecret: "s", name: "Acme Corp", createdAt: 0 };
  const fakeTmpl = {
    hash: "a".repeat(64),
    tenantId: "t1",
    content: MARKED_TEMPLATE,
    meta: { title: "Software License Agreement", description: "Test NDA" },
    createdAt: 0,
  };

  it("includes tenant name in header", () => {
    const html = renderReviewPage({ tenant: fakeTenant, tmpl: fakeTmpl, reqConfig: null, baseUrl: BASE_URL });
    assert.ok(html.includes("Acme Corp"));
  });

  it("includes the template hash in the footer", () => {
    const html = renderReviewPage({ tenant: fakeTenant, tmpl: fakeTmpl, reqConfig: null, baseUrl: BASE_URL });
    assert.ok(html.includes("aaaaaaaaaa"), "footer should show first chars of hash");
  });

  it("includes the accept endpoint URL in the JSON data island", () => {
    const html = renderReviewPage({ tenant: fakeTenant, tmpl: fakeTmpl, reqConfig: null, baseUrl: BASE_URL });
    assert.ok(html.includes(`/v1/t1/accept`));
  });

  it("renders required party fields as inputs", () => {
    const html = renderReviewPage({
      tenant: fakeTenant,
      tmpl: fakeTmpl,
      reqConfig: {
        id: "r1", tenantId: "t1", templateHash: fakeTmpl.hash,
        resource: "*", expiresIn: 3600,
        requiredPartyFields: ["name", "email"],
        createdAt: 0,
      },
      baseUrl: BASE_URL,
    });
    assert.ok(html.includes('id="party-name"'));
    assert.ok(html.includes('id="party-email"'));
    assert.ok(html.includes('type="email"'), "email field should use type=email");
  });

  it("renders negotiable fields when present", () => {
    const html = renderReviewPage({
      tenant: fakeTenant,
      tmpl: fakeTmpl,
      reqConfig: {
        id: "r1", tenantId: "t1", templateHash: fakeTmpl.hash,
        resource: "*", expiresIn: 3600,
        requiredPartyFields: ["name"],
        negotiable: true,
        negotiableFields: [
          { field: "licenseFee", description: "License Fee ($)" },
          { field: "termMonths", description: "Term (months)" },
        ],
        createdAt: 0,
      },
      baseUrl: BASE_URL,
    });
    assert.ok(html.includes('id="neg-licenseFee"'));
    assert.ok(html.includes('id="neg-termMonths"'));
    assert.ok(html.includes("Propose Changes"), "negotiate button should appear");
  });

  it("renders a select for negotiable fields with allowedValues", () => {
    const html = renderReviewPage({
      tenant: fakeTenant,
      tmpl: fakeTmpl,
      reqConfig: {
        id: "r1", tenantId: "t1", templateHash: fakeTmpl.hash,
        resource: "*", expiresIn: 3600,
        requiredPartyFields: ["name"],
        negotiable: true,
        negotiableFields: [
          { field: "plan", description: "Plan", allowedValues: ["starter", "pro", "enterprise"] },
        ],
        createdAt: 0,
      },
      baseUrl: BASE_URL,
    });
    assert.ok(html.includes("<select"), "should render a <select> for fields with allowedValues");
    assert.ok(html.includes("starter"));
    assert.ok(html.includes("enterprise"));
  });

  it("populates current clause values as placeholders in negotiable field inputs", () => {
    const html = renderReviewPage({
      tenant: fakeTenant,
      tmpl: fakeTmpl,
      reqConfig: {
        id: "r1", tenantId: "t1", templateHash: fakeTmpl.hash,
        resource: "*", expiresIn: 3600,
        requiredPartyFields: ["name"],
        negotiable: true,
        negotiableFields: [{ field: "licenseFee", description: "License Fee" }],
        createdAt: 0,
      },
      baseUrl: BASE_URL,
    });
    // Current clause value "$50,000" should appear as the placeholder
    assert.ok(html.includes("$50,000"), "current clause value should be shown as placeholder");
  });

  it("hides negotiate button when no negotiable fields exist", () => {
    const html = renderReviewPage({
      tenant: fakeTenant,
      tmpl: fakeTmpl,
      reqConfig: {
        id: "r1", tenantId: "t1", templateHash: fakeTmpl.hash,
        resource: "*", expiresIn: 3600,
        requiredPartyFields: ["name"],
        negotiable: false,
        createdAt: 0,
      },
      baseUrl: BASE_URL,
    });
    assert.ok(!html.includes('id="btn-negotiate"'), "negotiate button element should not appear for non-negotiable contracts");
  });

  it("escapes HTML in tenant name to prevent XSS", () => {
    const xssTenant = { ...fakeTenant, name: '<script>alert("xss")</script>' };
    const html = renderReviewPage({ tenant: xssTenant, tmpl: fakeTmpl, reqConfig: null, baseUrl: BASE_URL });
    assert.ok(!html.includes("<script>alert"), "raw script tag should not appear in output");
    assert.ok(html.includes("&lt;script&gt;"), "angle brackets should be escaped");
  });

  it("includes marked.js and Tailwind CDN scripts", () => {
    const html = renderReviewPage({ tenant: fakeTenant, tmpl: fakeTmpl, reqConfig: null, baseUrl: BASE_URL });
    assert.ok(html.includes("cdn.tailwindcss.com"));
    assert.ok(html.includes("marked"));
  });

  it("embeds template content in the JSON data island", () => {
    const html = renderReviewPage({ tenant: fakeTenant, tmpl: fakeTmpl, reqConfig: null, baseUrl: BASE_URL });
    assert.ok(html.includes("Software License Agreement"), "template content should be in the page");
  });
});

// ── GET /v1/:tenantId/review/:templateHash HTTP route ─────────────────────────

describe("GET /v1/:tenantId/review/:templateHash", () => {
  async function makeApp() {
    const stores = makeStores();
    const { tenant } = await stores.tenants.create("Test Corp");
    const tmpl = await stores.templates.register(
      tenant.tenantId,
      MARKED_TEMPLATE,
      { title: "Software License Agreement" },
    );
    await stores.requirements.upsert({
      tenantId: tenant.tenantId,
      templateHash: tmpl.hash,
      resource: "*",
      expiresIn: 3600,
      requiredPartyFields: ["name", "email"],
      negotiable: true,
      negotiableFields: [{ field: "licenseFee", description: "License Fee ($)" }],
    });
    const app = createFacilitatorApp({ ...stores, baseUrl: BASE_URL });
    return { app, tenant, tmpl };
  }

  it("returns 200 with HTML content-type", async () => {
    const { app, tenant, tmpl } = await makeApp();
    const res = await app.request(`/v1/${tenant.tenantId}/review/${tmpl.hash}`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("content-type")?.includes("text/html"));
  });

  it("renders the tenant name in the page", async () => {
    const { app, tenant, tmpl } = await makeApp();
    const res = await app.request(`/v1/${tenant.tenantId}/review/${tmpl.hash}`);
    const html = await res.text();
    assert.ok(html.includes("Test Corp"));
  });

  it("returns 404 for unknown tenant", async () => {
    const { app, tmpl } = await makeApp();
    const res = await app.request(`/v1/no-such-tenant/review/${tmpl.hash}`);
    assert.equal(res.status, 404);
  });

  it("returns 404 for unknown template hash", async () => {
    const { app, tenant } = await makeApp();
    const res = await app.request(`/v1/${tenant.tenantId}/review/${"b".repeat(64)}`);
    assert.equal(res.status, 404);
  });

  it("returns 404 if template belongs to a different tenant", async () => {
    const stores = makeStores();
    const { tenant: t1 } = await stores.tenants.create("Tenant One");
    const { tenant: t2 } = await stores.tenants.create("Tenant Two");
    const tmpl = await stores.templates.register(t1.tenantId, "# T1 Contract", {});
    const app = createFacilitatorApp({ ...stores, baseUrl: BASE_URL });

    const res = await app.request(`/v1/${t2.tenantId}/review/${tmpl.hash}`);
    assert.equal(res.status, 404);
  });

  it("renders negotiable fields from requirements config", async () => {
    const { app, tenant, tmpl } = await makeApp();
    const res = await app.request(`/v1/${tenant.tenantId}/review/${tmpl.hash}`);
    const html = await res.text();
    assert.ok(html.includes("neg-licenseFee"), "negotiable field input should appear");
    assert.ok(html.includes("Propose Changes"), "negotiate button should appear");
  });

  it("renders required party fields", async () => {
    const { app, tenant, tmpl } = await makeApp();
    const res = await app.request(`/v1/${tenant.tenantId}/review/${tmpl.hash}`);
    const html = await res.text();
    assert.ok(html.includes("party-name"));
    assert.ok(html.includes("party-email"));
  });

  it("still renders when no requirements config exists", async () => {
    const stores = makeStores();
    const { tenant } = await stores.tenants.create("No Req Corp");
    const tmpl = await stores.templates.register(tenant.tenantId, "# Simple Contract", {});
    const app = createFacilitatorApp({ ...stores, baseUrl: BASE_URL });
    const res = await app.request(`/v1/${tenant.tenantId}/review/${tmpl.hash}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("Accept Contract"));
  });
});
