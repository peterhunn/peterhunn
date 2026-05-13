import { Hono } from "hono";
import { signToken, verifyToken } from "@x490/protocol";
import type { AcceptRequest, AcceptResponse, VerifyResponse, RevokeRequest, RevokeResponse, NegotiableField } from "@x490/protocol";
import type { TenantStore, TemplateStore, AgreementStore } from "./store.js";
import type { Tenant, RegisteredTemplate } from "./types.js";

export interface FacilitatorAppOptions {
  tenants: TenantStore;
  templates: TemplateStore;
  agreements: AgreementStore;
  /** Public base URL of this facilitator, e.g. "https://facilitator.x490.dev" */
  baseUrl: string;
}

type AuthEnv = { Variables: { tenant: Tenant } };

/**
 * Creates the facilitator Hono app.
 *
 * Two audiences:
 *   - Server operators (authenticated with X-API-Key): register templates,
 *     manage agreements, build requirements
 *   - AI agents / end users (no auth): accept contracts, verify tokens
 *
 * Routes:
 *
 *   Operator-facing (X-API-Key required):
 *     POST /v1/tenants                     sign up → { tenantId, apiKey }
 *     POST /v1/templates                   register template → { hash, url }
 *     GET  /v1/agreements                  list agreements for tenant
 *     GET  /v1/agreements/:contractId      get one agreement
 *     POST /v1/:tenantId/revoke            revoke an agreement
 *     POST /v1/requirements                build ready-to-use ContractRequirements
 *
 *   Agent-facing (public):
 *     GET  /v1/templates/:hash             serve template content
 *     POST /v1/:tenantId/accept            accept contract → token
 *     GET  /v1/:tenantId/verify            verify token
 */
export function createFacilitatorApp(opts: FacilitatorAppOptions): Hono {
  const { tenants, templates, agreements, baseUrl } = opts;

  // Public app — no auth required
  const app = new Hono();

  // Authenticated sub-app — all routes require X-API-Key
  // IMPORTANT: public routes on `app` are registered FIRST so they take precedence
  // over the wildcard middleware in `authed` when mounted via app.route("/", authed).
  const authed = new Hono<AuthEnv>();

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: err.message }, 500);
  });

  authed.use("*", async (c, next) => {
    const raw = c.req.header("X-API-Key");
    if (!raw) return c.json({ error: "X-API-Key header required" }, 401);
    const tenant = await tenants.findByApiKey(raw);
    if (!tenant) return c.json({ error: "Invalid API key" }, 401);
    c.set("tenant", tenant);
    await next();
  });

  // ── Tenant sign-up (no auth — first call) ──────────────────────────────────

  app.post("/v1/tenants", async (c) => {
    const { name } = await c.req.json<{ name: string }>();
    if (!name?.trim()) return c.json({ error: "name is required" }, 400);
    const { tenant, rawApiKey } = await tenants.create(name.trim());
    return c.json(
      {
        tenantId: tenant.tenantId,
        apiKey: rawApiKey,
        note: "Store your API key — it will not be shown again.",
      },
      201,
    );
  });

  // ── Template serving (public) ──────────────────────────────────────────────

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

  // ── Accept endpoint (agent-facing, public) ─────────────────────────────────

  app.post("/v1/:tenantId/accept", async (c) => {
    const tenantId = c.req.param("tenantId");
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

    const contractId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = 3600;
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

    const response: AcceptResponse = { status: "accepted", contractId, token };
    return c.json(response, 200);
  });

  // ── Verify endpoint (server-facing, public) ────────────────────────────────

  app.get("/v1/:tenantId/verify", async (c) => {
    const tenantId = c.req.param("tenantId");
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

  // ── Template registration ──────────────────────────────────────────────────

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

  // ── Build ContractRequirements ─────────────────────────────────────────────

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

    const requirements = buildRequirements(body, tenant.tenantId, body.templateHash, baseUrl);
    return c.json(requirements, 200);
  });

  // ── Agreement listing ──────────────────────────────────────────────────────

  authed.get("/v1/agreements", async (c) => {
    const tenant = c.get("tenant");
    const resource = c.req.query("resource");
    let records = await agreements.listByTenant(tenant.tenantId);
    if (resource) records = records.filter((r) => r.resource === resource || r.resource === "*");
    return c.json({ agreements: records.map(safeRecord) });
  });

  authed.get("/v1/agreements/:contractId", async (c) => {
    const tenant = c.get("tenant");
    const record = await agreements.findById(c.req.param("contractId"));
    if (!record || record.tenantId !== tenant.tenantId) {
      return c.json({ error: "Agreement not found" }, 404);
    }
    return c.json(safeRecord(record));
  });

  // ── Revocation ─────────────────────────────────────────────────────────────

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
    const response: RevokeResponse = { revoked: ok, contractId };
    return c.json(response, 200);
  });

  // Mount authenticated routes AFTER public routes so the wildcard auth
  // middleware in `authed` does not intercept public endpoints.
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
