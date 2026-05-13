import { Hono } from "hono";
import { cors } from "hono/cors";
import { signToken, verifyToken } from "@x490/protocol";
import type { AcceptRequest, AcceptResponse, VerifyResponse, RevokeRequest, RevokeResponse, NegotiableField } from "@x490/protocol";
import type { TenantStore, TemplateStore, AgreementStore, RequirementsStore, WebhookStore } from "./store.js";
import type { Tenant, RegisteredTemplate, WebhookEventType } from "./types.js";
import { rateLimit } from "./rate-limit.js";
import { deliverWebhookEvent } from "./webhook.js";

export interface FacilitatorAppOptions {
  tenants: TenantStore;
  templates: TemplateStore;
  agreements: AgreementStore;
  requirements: RequirementsStore;
  webhooks: WebhookStore;
  /** Public base URL of this facilitator, e.g. "https://facilitator.x490.dev" */
  baseUrl: string;
}

type AuthEnv = { Variables: { tenant: Tenant } };

/**
 * Creates the facilitator Hono app.
 *
 * Two audiences:
 *   - Server operators (X-API-Key): sign up, register templates, manage agreements
 *   - AI agents (public): accept contracts, verify tokens
 *
 * Routes:
 *
 *   Public:
 *     POST /v1/tenants                     sign up → { tenantId, apiKey, keyId }
 *     GET  /v1/templates/:hash             serve template content
 *     POST /v1/:tenantId/accept            accept contract → token  (rate limited)
 *     GET  /v1/:tenantId/verify            verify token            (rate limited)
 *
 *   Operator-facing (X-API-Key required):
 *     POST /v1/templates                   register template
 *     POST /v1/requirements                build ContractRequirements
 *     GET  /v1/agreements                  list agreements (paginated)
 *     GET  /v1/agreements/:contractId      get one agreement
 *     POST /v1/:tenantId/revoke            revoke agreement
 *     GET  /v1/apikeys                     list API keys
 *     POST /v1/apikeys                     create additional API key
 *     DELETE /v1/apikeys/:keyId            revoke an API key
 */
export function createFacilitatorApp(opts: FacilitatorAppOptions): Hono {
  const { tenants, templates, agreements, requirements, webhooks, baseUrl } = opts;

  const app = new Hono();
  const authed = new Hono<AuthEnv>();

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: err.message }, 500);
  });

  // ── Health check ───────────────────────────────────────────────────────────────
  app.get("/health", (c) => c.json({ ok: true }));

  // ── CORS ──────────────────────────────────────────────────────────────────────
  // Allow browsers (operator dashboard) and AI agent runtimes to call the API.
  app.use(
    "/v1/*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "X-API-Key"],
      maxAge: 86400,
    }),
  );

  // ── Auth middleware (applied selectively via sub-app) ──────────────────────

  authed.use("*", async (c, next) => {
    const raw = c.req.header("X-API-Key");
    if (!raw) return c.json({ error: "X-API-Key header required" }, 401);
    const tenant = await tenants.findByApiKey(raw);
    if (!tenant) return c.json({ error: "Invalid API key" }, 401);
    c.set("tenant", tenant);
    await next();
  });

  // ── Tenant sign-up (public — first call) ───────────────────────────────────

  app.post("/v1/tenants", async (c) => {
    const { name } = await c.req.json<{ name: string }>();
    if (!name?.trim()) return c.json({ error: "name is required" }, 400);
    const { tenant, rawApiKey, keyId } = await tenants.create(name.trim());
    return c.json(
      {
        tenantId: tenant.tenantId,
        apiKey: rawApiKey,
        keyId,
        note: "Store your API key — it will not be shown again.",
      },
      201,
    );
  });

  // ── Template serving (public) ──────────────────────────────────────────────
  // Public routes registered BEFORE app.route("/", authed) so they take
  // precedence over the wildcard auth middleware in the authed sub-app.

  app.get("/v1/templates/:hash", async (c) => {
    const tmpl = await templates.findByHash(c.req.param("hash"));
    if (!tmpl) return c.json({ error: "Template not found" }, 404);
    return c.json({
      hash: tmpl.hash,
      content: tmpl.content,
      title: tmpl.meta.title,
      description: tmpl.meta.description,
    });
  });

  // ── Accept endpoint (agent-facing, public, rate limited) ───────────────────

  const acceptLimiter = rateLimit({ windowMs: 60_000, max: 30 });

  app.post("/v1/:tenantId/accept", acceptLimiter, async (c) => {
    const tenantId = c.req.param("tenantId") ?? "";
    const tenant = await tenants.findById(tenantId);
    if (!tenant) return c.json({ error: "Tenant not found" }, 404);

    const body = await c.req.json<AcceptRequest>();

    if (!body.templateHash) return c.json({ error: "templateHash required" }, 400);
    if (!body.partyData || typeof body.partyData !== "object") {
      return c.json({ error: "partyData required" }, 400);
    }

    const tmpl = await templates.findByHash(body.templateHash);
    if (!tmpl || tmpl.tenantId !== tenantId) {
      return c.json({ error: "Template not found for this tenant" }, 404);
    }

    // Look up the operator-configured TTL; fall back to 1 hour.
    const reqConfig = await requirements.findByTemplate(tenantId, body.templateHash);
    const expiresIn = reqConfig?.expiresIn ?? 3600;

    const contractId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const partyId = body.partyData["partyId"] ?? body.partyData["name"] ?? contractId;

    const token = await signToken(
      {
        contractId,
        templateHash: body.templateHash,
        partyId,
        resource: "*",
        iat: now,
        exp: now + expiresIn,
      },
      tenant.hmacSecret,
    );

    await agreements.record({
      contractId,
      tenantId,
      templateHash: body.templateHash,
      partyId,
      resource: "*",
      partyData: body.partyData,
      token,
      issuedAt: now,
      expiresAt: now + expiresIn,
    });

    // Fire-and-forget — webhook delivery must not block or fail the response.
    void deliverWebhookEvent(webhooks, tenantId, "agreement.created", {
      contractId, tenantId, templateHash: body.templateHash, partyId,
      resource: "*", partyData: body.partyData, token, issuedAt: now, expiresAt: now + expiresIn,
    });

    const response: AcceptResponse = { status: "accepted", contractId, token };
    return c.json(response, 200);
  });

  // ── Verify endpoint (server-facing, public, rate limited) ─────────────────

  const verifyLimiter = rateLimit({ windowMs: 60_000, max: 120 });

  app.get("/v1/:tenantId/verify", verifyLimiter, async (c) => {
    const tenantId = c.req.param("tenantId") ?? "";
    const tenant = await tenants.findById(tenantId);
    if (!tenant) return c.json({ error: "Tenant not found" }, 404);

    const token = c.req.query("token");
    const resource = c.req.query("resource") ?? "*";
    if (!token) return c.json({ error: "token query param required" }, 400);

    const result = await verifyToken(token, tenant.hmacSecret, resource);
    if (!result.valid) {
      const response: VerifyResponse = { valid: false, reason: result.reason };
      return c.json(response, 200);
    }

    const revoked = await agreements.isRevoked(result.payload.contractId);
    if (revoked) {
      const response: VerifyResponse = { valid: false, reason: "contract revoked" };
      return c.json(response, 200);
    }

    const response: VerifyResponse = {
      valid: true,
      contractId: result.payload.contractId,
      partyId: result.payload.partyId,
      expiresAt: result.payload.exp,
    };
    return c.json(response, 200);
  });

  // ── Template registration (auth required) ─────────────────────────────────

  authed.post("/v1/templates", async (c) => {
    const tenant = c.get("tenant");
    const body = await c.req.json<{
      content: string;
      title?: string;
      description?: string;
    }>();
    if (!body.content?.trim()) return c.json({ error: "content is required" }, 400);

    const meta: RegisteredTemplate["meta"] = {};
    if (body.title !== undefined) meta.title = body.title;
    if (body.description !== undefined) meta.description = body.description;
    const tmpl = await templates.register(tenant.tenantId, body.content, meta);
    return c.json(
      {
        hash: tmpl.hash,
        url: `${baseUrl}/v1/templates/${tmpl.hash}`,
        title: tmpl.meta.title,
        description: tmpl.meta.description,
      },
      201,
    );
  });

  // ── Build ContractRequirements (auth required) ────────────────────────────

  authed.post("/v1/requirements", async (c) => {
    const tenant = c.get("tenant");
    const body = await c.req.json<{
      templateHash: string;
      requiredPartyFields: string[];
      resource: string;
      description: string;
      expiresIn: number;
      negotiable?: boolean;
      negotiableFields?: NegotiableField[];
      requiredParties?: number;
      jurisdiction?: string;
      governingLaw?: string;
    }>();

    const tmpl = await templates.findByHash(body.templateHash);
    if (!tmpl) return c.json({ error: "Template not found. Register it first with POST /v1/templates." }, 404);
    if (tmpl.tenantId !== tenant.tenantId) return c.json({ error: "Template belongs to a different tenant" }, 403);

    // Persist so the accept endpoint can look up the correct TTL.
    await requirements.upsert({
      tenantId: tenant.tenantId,
      templateHash: body.templateHash,
      resource: body.resource,
      expiresIn: body.expiresIn,
      requiredPartyFields: body.requiredPartyFields,
    });

    const reqs = buildRequirements(body, tenant.tenantId, body.templateHash, baseUrl);
    return c.json(reqs, 200);
  });

  // ── Agreement listing (auth required, paginated) ───────────────────────────

  authed.get("/v1/agreements", async (c) => {
    const tenant = c.get("tenant");
    const resource = c.req.query("resource");
    const limit = Math.min(Number(c.req.query("limit") ?? "50"), 200);
    const after = c.req.query("after");

    const { agreements: records, nextCursor } = await agreements.listByTenant(tenant.tenantId, {
      ...(resource ? { resource } : {}),
      limit,
      ...(after ? { after } : {}),
    });

    return c.json({
      agreements: records.map(safeRecord),
      nextCursor,
    });
  });

  authed.get("/v1/agreements/:contractId", async (c) => {
    const tenant = c.get("tenant");
    const record = await agreements.findById(c.req.param("contractId"));
    if (!record || record.tenantId !== tenant.tenantId) {
      return c.json({ error: "Agreement not found" }, 404);
    }
    return c.json(safeRecord(record));
  });

  // ── Revocation (auth required) ─────────────────────────────────────────────

  authed.post("/v1/:tenantId/revoke", async (c) => {
    const tenant = c.get("tenant");
    if (c.req.param("tenantId") !== tenant.tenantId) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const { contractId, reason } = await c.req.json<RevokeRequest>();
    if (!contractId) return c.json({ error: "contractId required" }, 400);

    const record = await agreements.findById(contractId);
    if (!record || record.tenantId !== tenant.tenantId) {
      return c.json({ error: "Agreement not found" }, 404);
    }

    const ok = await agreements.revoke(contractId, reason);
    if (ok) {
      const updated = await agreements.findById(contractId);
      if (updated) void deliverWebhookEvent(webhooks, tenant.tenantId, "agreement.revoked", updated);
    }
    const response: RevokeResponse = { revoked: ok, contractId };
    return c.json(response, 200);
  });

  // ── API key management (auth required) ────────────────────────────────────

  authed.get("/v1/apikeys", async (c) => {
    const tenant = c.get("tenant");
    const keys = await tenants.listApiKeys(tenant.tenantId);
    return c.json({
      apiKeys: keys.map((k) => ({
        keyId: k.keyId,
        name: k.name,
        createdAt: k.createdAt,
        revokedAt: k.revokedAt,
      })),
    });
  });

  authed.post("/v1/apikeys", async (c) => {
    const tenant = c.get("tenant");
    const body = await c.req.json<{ name?: string }>();
    const name = body.name?.trim() || "default";
    const { keyId, rawApiKey } = await tenants.createApiKey(tenant.tenantId, name);
    return c.json(
      {
        keyId,
        apiKey: rawApiKey,
        name,
        note: "Store your API key — it will not be shown again.",
      },
      201,
    );
  });

  authed.delete("/v1/apikeys/:keyId", async (c) => {
    const tenant = c.get("tenant");
    const keyId = c.req.param("keyId");
    // Ensure the key belongs to this tenant before revoking.
    const keys = await tenants.listApiKeys(tenant.tenantId);
    const key = keys.find((k) => k.keyId === keyId);
    if (!key) return c.json({ error: "API key not found" }, 404);
    await tenants.revokeApiKey(keyId);
    return c.json({ revoked: true, keyId });
  });

  // ── Webhook management (auth required) ────────────────────────────────────

  authed.get("/v1/webhooks", async (c) => {
    const tenant = c.get("tenant");
    const hooks = await webhooks.list(tenant.tenantId);
    return c.json({
      webhooks: hooks.map(({ secret: _s, ...safe }) => safe),
    });
  });

  authed.post("/v1/webhooks", async (c) => {
    const tenant = c.get("tenant");
    const body = await c.req.json<{ url: string; events: WebhookEventType[] }>();
    if (!body.url) return c.json({ error: "url is required" }, 400);
    if (!Array.isArray(body.events) || body.events.length === 0) {
      return c.json({ error: "events must be a non-empty array" }, 400);
    }
    const validEvents: WebhookEventType[] = ["agreement.created", "agreement.revoked"];
    const invalid = body.events.filter((e) => !validEvents.includes(e));
    if (invalid.length > 0) {
      return c.json({ error: `unknown events: ${invalid.join(", ")}`, validEvents }, 400);
    }
    const { webhook, secret } = await webhooks.create(tenant.tenantId, body.url, body.events);
    return c.json(
      {
        webhookId: webhook.webhookId,
        url: webhook.url,
        events: webhook.events,
        secret,
        note: "Store your signing secret — it will not be shown again.",
      },
      201,
    );
  });

  authed.delete("/v1/webhooks/:webhookId", async (c) => {
    const tenant = c.get("tenant");
    const webhookId = c.req.param("webhookId");
    const hook = await webhooks.findById(webhookId);
    if (!hook || hook.tenantId !== tenant.tenantId) {
      return c.json({ error: "Webhook not found" }, 404);
    }
    await webhooks.disable(webhookId);
    return c.json({ disabled: true, webhookId });
  });

  // Mount authenticated routes after public routes.
  app.route("/", authed);

  return app;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildRequirements(
  opts: {
    templateHash: string;
    requiredPartyFields: string[];
    resource: string;
    description: string;
    expiresIn: number;
    negotiable?: boolean;
    negotiableFields?: NegotiableField[];
    requiredParties?: number;
    jurisdiction?: string;
    governingLaw?: string;
  },
  tenantId: string,
  templateHash: string,
  baseUrl: string,
) {
  return {
    scheme: "x490" as const,
    version: 1 as const,
    templateId: templateHash,
    templateUrl: `${baseUrl}/v1/templates/${templateHash}`,
    templateHash,
    requiredPartyFields: opts.requiredPartyFields,
    acceptEndpoint: `${baseUrl}/v1/${tenantId}/accept`,
    verifyEndpoint: `${baseUrl}/v1/${tenantId}/verify`,
    revokeEndpoint: `${baseUrl}/v1/${tenantId}/revoke`,
    expiresIn: opts.expiresIn,
    resource: opts.resource,
    description: opts.description,
    negotiable: opts.negotiable ?? false,
    ...(opts.negotiableFields ? { negotiableFields: opts.negotiableFields } : {}),
    ...(opts.requiredParties ? { requiredParties: opts.requiredParties } : {}),
    ...(opts.jurisdiction ? { jurisdiction: opts.jurisdiction } : {}),
    ...(opts.governingLaw ? { governingLaw: opts.governingLaw } : {}),
  };
}

/** Strip the token from outbound agreement records — it's large and not needed in lists. */
function safeRecord(r: import("./types.js").AgreementRecord) {
  const { token: _t, ...rest } = r;
  return rest;
}
