import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { signToken, verifyToken } from "@x490/protocol";
import type { AcceptRequest, AcceptResponse, VerifyResponse, RevokeRequest, RevokeResponse, NegotiableField } from "@x490/protocol";
import type { ContractTerms } from "@x490/core";
import type { TenantStore, TemplateStore, AgreementStore, RequirementsStore, WebhookStore, EventStore, PendingContractStore, WebhookDeliveryStore } from "./store.js";
import type { Tenant, RegisteredTemplate, WebhookEventType, ContractEventRecord } from "./types.js";
import { rateLimit } from "./rate-limit.js";
import { deliverWebhookEvent, assertSafeWebhookUrl } from "./webhook.js";

export interface FacilitatorAppOptions {
  tenants: TenantStore;
  templates: TemplateStore;
  agreements: AgreementStore;
  requirements: RequirementsStore;
  webhooks: WebhookStore;
  events?: EventStore;
  pendingContracts?: PendingContractStore;
  deliveries?: WebhookDeliveryStore;
  /** Public base URL of this facilitator, e.g. "https://facilitator.x490.dev" */
  baseUrl: string;
  /** Auth0 domain, e.g. "your-tenant.auth0.com". Enables JWT auth when set. */
  auth0Domain?: string;
  /** Auth0 API audience identifier. Required when auth0Domain is set. */
  auth0Audience?: string;
}

type AuthEnv = { Variables: { tenant: Tenant } };

const MIN_EXPIRES_IN = 60;          // 1 minute
const MAX_EXPIRES_IN = 31_536_000;  // 1 year

// In-process idempotency cache for the accept endpoint.
// Key: `${tenantId}:${idempotencyKey}` — scoped per tenant to prevent cross-tenant replay.
// Swap the Map for Redis in multi-instance deployments.
const idempotencyCache = new Map<string, { response: AcceptResponse; expiresAt: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of idempotencyCache) {
    if (v.expiresAt < now) idempotencyCache.delete(k);
  }
}, 60_000).unref();

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
// JWKS cache — one RemoteJWKSet per Auth0 domain (reused across requests).
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJWKS(domain: string): ReturnType<typeof createRemoteJWKSet> {
  if (!jwksCache.has(domain)) {
    jwksCache.set(domain, createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`)));
  }
  return jwksCache.get(domain)!;
}

export function createFacilitatorApp(opts: FacilitatorAppOptions): Hono {
  const { tenants, templates, agreements, requirements, webhooks, events, pendingContracts, deliveries, baseUrl } = opts;

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
      allowHeaders: ["Content-Type", "X-API-Key", "Authorization", "Idempotency-Key"],
      maxAge: 86400,
    }),
  );

  // ── Body size limit ───────────────────────────────────────────────────────────
  // 1 MB is generous for any legitimate API payload (template content, partyData, etc.)
  app.use(
    "/v1/*",
    bodyLimit({
      maxSize: 1 * 1024 * 1024,
      onError: (c) => c.json({ error: "Request body too large (max 1 MB)" }, 413),
    }),
  );

  // ── Auth middleware (applied selectively via sub-app) ──────────────────────

  authed.use("*", async (c, next) => {
    // API key (operator tooling / CI / legacy dashboard)
    const apiKey = c.req.header("X-API-Key");
    if (apiKey) {
      const tenant = await tenants.findByApiKey(apiKey);
      if (!tenant) return c.json({ error: "Invalid API key" }, 401);
      c.set("tenant", tenant);
      return next();
    }

    // Auth0 JWT (dashboard proxy)
    if (opts.auth0Domain && opts.auth0Audience) {
      const authHeader = c.req.header("Authorization");
      if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.slice(7);
        try {
          const { payload } = await jwtVerify(token, getJWKS(opts.auth0Domain), {
            issuer: `https://${opts.auth0Domain}/`,
            audience: opts.auth0Audience,
          });
          if (payload.sub) {
            const tenant = await tenants.findOrCreateByAuth0Sub(payload.sub);
            c.set("tenant", tenant);
            return next();
          }
        } catch {
          return c.json({ error: "Invalid token" }, 401);
        }
      }
    }

    return c.json({ error: "Authentication required" }, 401);
  });

  // ── Tenant sign-up (public — first call) ───────────────────────────────────

  const signupLimiter = rateLimit({ windowMs: 60_000, max: 5 });
  app.post("/v1/tenants", signupLimiter, async (c) => {
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
      ...(tmpl.terms ? { terms: tmpl.terms } : {}),
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
    if (!body.partyData || typeof body.partyData !== "object" || Array.isArray(body.partyData)) {
      return c.json({ error: "partyData must be a non-null object" }, 400);
    }

    // Validate all partyData values are strings (schema boundary enforcement).
    const nonStringFields = Object.entries(body.partyData)
      .filter(([, v]) => typeof v !== "string")
      .map(([k]) => k);
    if (nonStringFields.length > 0) {
      return c.json({ error: `partyData values must be strings; invalid fields: ${nonStringFields.join(", ")}` }, 400);
    }

    const tmpl = await templates.findByHash(body.templateHash);
    if (!tmpl || tmpl.tenantId !== tenantId) {
      return c.json({ error: "Template not found for this tenant" }, 404);
    }

    // Look up the operator-configured TTL; fall back to 1 hour.
    const reqConfig = await requirements.findByTemplate(tenantId, body.templateHash);
    const expiresIn = reqConfig?.expiresIn ?? 3600;

    // Validate that all operator-declared required fields are present.
    if (reqConfig?.requiredPartyFields?.length) {
      const missing = reqConfig.requiredPartyFields.filter(
        (f) => !(f in body.partyData) || (body.partyData[f] as string).trim() === "",
      );
      if (missing.length > 0) {
        return c.json({ error: `Missing required party fields: ${missing.join(", ")}` }, 400);
      }
    }

    // Idempotency: return the cached response for duplicate requests.
    const idempotencyKey = c.req.header("Idempotency-Key");
    if (idempotencyKey) {
      const cacheKey = `${tenantId}:${idempotencyKey}`;
      const cached = idempotencyCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return c.json(cached.response, 200);
      }
    }

    // Multi-party contract flow
    const multiPartyBody = body as AcceptRequest & { pendingContractId?: string };
    if (reqConfig && (reqConfig.requiredParties ?? 1) > 1 && pendingContracts) {
      const now = Math.floor(Date.now() / 1000);
      const partyId = body.partyData["partyId"] ?? body.partyData["name"] ?? crypto.randomUUID();

      if (multiPartyBody.pendingContractId) {
        // Subsequent signer — add party to existing pending contract
        const entry = await pendingContracts.addParty(multiPartyBody.pendingContractId, partyId, body.partyData);
        if (!entry) return c.json({ error: "Pending contract not found or already completed" }, 404);

        if (entry.acceptances.length >= (reqConfig.requiredParties ?? 1)) {
          // All parties have signed — complete and issue token
          await pendingContracts.complete(entry.contractId);

          const token = await signToken(
            {
              contractId: entry.contractId,
              templateHash: body.templateHash,
              partyId,
              resource: "*",
              iat: now,
              exp: now + expiresIn,
            },
            tenant.hmacSecret,
          );

          await agreements.record({
            contractId: entry.contractId,
            tenantId,
            templateHash: body.templateHash,
            partyId,
            resource: "*",
            partyData: body.partyData,
            token,
            issuedAt: now,
            expiresAt: now + expiresIn,
          });

          void deliverWebhookEvent(webhooks, tenantId, "agreement.created", {
            contractId: entry.contractId, tenantId, templateHash: body.templateHash, partyId,
            resource: "*", partyData: body.partyData, token, issuedAt: now, expiresAt: now + expiresIn,
          }, deliveries);

          if (events) {
            const parentId = await events.latestEventId(entry.contractId);
            void events.append({
              eventId: crypto.randomUUID(),
              contractId: entry.contractId,
              tenantId,
              type: "agreement.accepted",
              party: partyId,
              payload: { templateHash: body.templateHash, partyData: body.partyData },
              parentEventIds: parentId ? [parentId] : [],
              createdAt: now,
            });
          }

          const response: AcceptResponse = { status: "accepted", contractId: entry.contractId, token };
          return c.json(response, 200);
        } else {
          // More parties still needed
          return c.json({
            status: "pending",
            contractId: entry.contractId,
            token: "",
            pendingAcceptances: entry.acceptances.length,
            requiredAcceptances: reqConfig.requiredParties,
          }, 200);
        }
      } else {
        // First signer — create a new pending contract
        const entry = await pendingContracts.create({
          contractId: crypto.randomUUID(),
          tenantId,
          templateHash: body.templateHash,
          requiredParties: reqConfig.requiredParties ?? 2,
        });
        await pendingContracts.addParty(entry.contractId, partyId, body.partyData);

        if (events) {
          void events.append({
            eventId: crypto.randomUUID(),
            contractId: entry.contractId,
            tenantId,
            type: "agreement.pending",
            party: partyId,
            payload: { templateHash: body.templateHash, partyData: body.partyData, requiredParties: reqConfig.requiredParties },
            parentEventIds: [],
            createdAt: now,
          });
        }

        return c.json({
          status: "pending",
          contractId: entry.contractId,
          token: "",
          pendingAcceptances: 1,
          requiredAcceptances: reqConfig.requiredParties,
        }, 200);
      }
    }

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
    }, deliveries);

    // Root event in the contract DAG — no parents.
    const acceptEventId = crypto.randomUUID();
    if (events) {
      void events.append({
        eventId: acceptEventId,
        contractId,
        tenantId,
        type: "agreement.accepted",
        party: partyId,
        payload: { templateHash: body.templateHash, partyData: body.partyData },
        parentEventIds: [],
        createdAt: now,
      });
    }

    const response: AcceptResponse = { status: "accepted", contractId, token };

    if (idempotencyKey) {
      idempotencyCache.set(`${tenantId}:${idempotencyKey}`, {
        response,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      });
    }

    return c.json(response, 200);
  });

  // ── Negotiate endpoint (agent-facing, public, rate limited) ──────────────

  app.post("/v1/:tenantId/negotiate", acceptLimiter, async (c) => {
    const tenantId = c.req.param("tenantId") ?? "";
    const tenant = await tenants.findById(tenantId);
    if (!tenant) return c.json({ error: "Tenant not found" }, 404);

    const body = await c.req.json<AcceptRequest>();
    if (!body.templateHash) return c.json({ error: "templateHash required" }, 400);
    if (!body.partyData || typeof body.partyData !== "object" || Array.isArray(body.partyData)) {
      return c.json({ error: "partyData must be a non-null object" }, 400);
    }

    const tmpl = await templates.findByHash(body.templateHash);
    if (!tmpl || tmpl.tenantId !== tenantId) {
      return c.json({ error: "Template not found for this tenant" }, 404);
    }

    const reqConfig = await requirements.findByTemplate(tenantId, body.templateHash);
    if (!reqConfig?.negotiable) {
      return c.json({ error: "This contract is not negotiable" }, 400);
    }

    // Validate each proposed term against the negotiableFields allow-list.
    const proposed = body.negotiationTerms ?? {};
    const negotiableFields = reqConfig.negotiableFields ?? [];
    const rejectedFields: string[] = [];

    for (const [field, value] of Object.entries(proposed)) {
      const def = negotiableFields.find((f) => f.field === field);
      if (!def) { rejectedFields.push(field); continue; }
      if (def.allowedValues && !def.allowedValues.includes(String(value))) {
        rejectedFields.push(field);
      }
    }

    if (rejectedFields.length > 0) {
      const counterOffer = buildRequirements(
        {
          templateHash: body.templateHash,
          requiredPartyFields: reqConfig.requiredPartyFields,
          resource: reqConfig.resource,
          description: "",
          expiresIn: reqConfig.expiresIn,
          negotiable: reqConfig.negotiable ?? false,
          ...(reqConfig.negotiableFields ? { negotiableFields: reqConfig.negotiableFields } : {}),
        },
        tenantId,
        body.templateHash,
        baseUrl,
      );
      const response: AcceptResponse = { status: "counter_offer", contractId: "", token: "", counterOffer };
      return c.json({ ...response, rejectedFields }, 200);
    }

    // All proposed terms are acceptable — validate partyData and issue token.
    const nonStringFields = Object.entries(body.partyData)
      .filter(([, v]) => typeof v !== "string")
      .map(([k]) => k);
    if (nonStringFields.length > 0) {
      return c.json({ error: `partyData values must be strings; invalid fields: ${nonStringFields.join(", ")}` }, 400);
    }
    if (reqConfig.requiredPartyFields?.length) {
      const missing = reqConfig.requiredPartyFields.filter(
        (f) => !(f in body.partyData) || (body.partyData[f] as string).trim() === "",
      );
      if (missing.length > 0) {
        return c.json({ error: `Missing required party fields: ${missing.join(", ")}` }, 400);
      }
    }

    const contractId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const partyId = body.partyData["partyId"] ?? body.partyData["name"] ?? contractId;
    const token = await signToken(
      { contractId, templateHash: body.templateHash, partyId, resource: "*", iat: now, exp: now + reqConfig.expiresIn },
      tenant.hmacSecret,
    );

    await agreements.record({
      contractId, tenantId, templateHash: body.templateHash, partyId,
      resource: "*", partyData: body.partyData, token,
      issuedAt: now, expiresAt: now + reqConfig.expiresIn,
    });

    void deliverWebhookEvent(webhooks, tenantId, "agreement.created", {
      contractId, tenantId, templateHash: body.templateHash, partyId,
      resource: "*", partyData: body.partyData, token, issuedAt: now, expiresAt: now + reqConfig.expiresIn,
    }, deliveries);

    if (events) {
      void events.append({
        eventId: crypto.randomUUID(),
        contractId, tenantId, type: "agreement.accepted", party: partyId,
        payload: { templateHash: body.templateHash, partyData: body.partyData, negotiationTerms: proposed },
        parentEventIds: [], createdAt: now,
      });
    }

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

  // ── Me endpoint (auth required) ───────────────────────────────────────────

  authed.get("/v1/me", async (c) => {
    const tenant = c.get("tenant");
    return c.json({ tenantId: tenant.tenantId, name: tenant.name });
  });

  // ── Template registration (auth required) ─────────────────────────────────

  authed.post("/v1/templates", async (c) => {
    const tenant = c.get("tenant");
    const body = await c.req.json<{
      content: string;
      title?: string;
      description?: string;
      terms?: ContractTerms;
    }>();
    if (!body.content?.trim()) return c.json({ error: "content is required" }, 400);

    const meta: RegisteredTemplate["meta"] = {};
    if (body.title !== undefined) meta.title = body.title;
    if (body.description !== undefined) meta.description = body.description;
    const tmpl = await templates.register(tenant.tenantId, body.content, meta, body.terms);
    return c.json(
      {
        hash: tmpl.hash,
        url: `${baseUrl}/v1/templates/${tmpl.hash}`,
        title: tmpl.meta.title,
        description: tmpl.meta.description,
        ...(tmpl.terms ? { terms: tmpl.terms } : {}),
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

    if (
      !Number.isInteger(body.expiresIn) ||
      body.expiresIn < MIN_EXPIRES_IN ||
      body.expiresIn > MAX_EXPIRES_IN
    ) {
      return c.json(
        { error: `expiresIn must be an integer between ${MIN_EXPIRES_IN} and ${MAX_EXPIRES_IN} seconds` },
        400,
      );
    }

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
      negotiable: body.negotiable ?? false,
      ...(body.negotiableFields ? { negotiableFields: body.negotiableFields } : {}),
      ...(body.requiredParties ? { requiredParties: body.requiredParties } : {}),
    });

    const reqs = buildRequirements(body, tenant.tenantId, body.templateHash, baseUrl);
    return c.json(reqs, 200);
  });

  // ── Template listing (auth required, paginated) ───────────────────────────

  authed.get("/v1/templates", async (c) => {
    const tenant = c.get("tenant");
    const limit = Math.min(Number(c.req.query("limit") ?? "50"), 200);
    const after = c.req.query("after");
    const { templates: records, nextCursor } = await templates.listByTenant(tenant.tenantId, {
      limit,
      ...(after ? { after } : {}),
    });
    return c.json({
      templates: records.map((t) => ({
        hash: t.hash,
        url: `${baseUrl}/v1/templates/${t.hash}`,
        title: t.meta.title,
        description: t.meta.description,
        ...(t.terms ? { terms: t.terms } : {}),
        createdAt: t.createdAt,
      })),
      nextCursor,
    });
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

  authed.get("/v1/agreements/:contractId/events", async (c) => {
    const tenant = c.get("tenant");
    const record = await agreements.findById(c.req.param("contractId"));
    if (!record || record.tenantId !== tenant.tenantId) {
      return c.json({ error: "Agreement not found" }, 404);
    }
    if (!events) return c.json({ events: [] });
    const dag = await events.listByContract(c.req.param("contractId"));
    return c.json({ events: dag });
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
      if (updated) void deliverWebhookEvent(webhooks, tenant.tenantId, "agreement.revoked", updated, deliveries);

      if (events) {
        const parentId = await events.latestEventId(contractId);
        void events.append({
          eventId: crypto.randomUUID(),
          contractId,
          tenantId: tenant.tenantId,
          type: "agreement.revoked",
          party: tenant.tenantId,
          payload: reason !== undefined ? { reason } : {},
          parentEventIds: parentId ? [parentId] : [],
          createdAt: Math.floor(Date.now() / 1000),
        });
      }
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
    try {
      await assertSafeWebhookUrl(body.url);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
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

  authed.get("/v1/webhooks/:webhookId/deliveries", async (c) => {
    const tenant = c.get("tenant");
    const webhookId = c.req.param("webhookId");
    const hook = await webhooks.findById(webhookId);
    if (!hook || hook.tenantId !== tenant.tenantId) {
      return c.json({ error: "Webhook not found" }, 404);
    }
    const list = await deliveries?.listByWebhook(webhookId, 50) ?? [];
    return c.json({ deliveries: list });
  });

  // ── Tenant deletion (auth required) ──────────────────────────────────────────

  authed.delete("/v1/tenants/:tenantId", async (c) => {
    const tenant = c.get("tenant");
    if (c.req.param("tenantId") !== tenant.tenantId) return c.json({ error: "Forbidden" }, 403);
    const ok = await tenants.delete(tenant.tenantId);
    return c.json({ deleted: ok, tenantId: tenant.tenantId });
  });

  // ── Custom contract events (auth required) ────────────────────────────────────

  authed.post("/v1/agreements/:contractId/events", async (c) => {
    const tenant = c.get("tenant");
    const record = await agreements.findById(c.req.param("contractId"));
    if (!record || record.tenantId !== tenant.tenantId) return c.json({ error: "Agreement not found" }, 404);
    if (record.revokedAt) return c.json({ error: "Cannot append events to a revoked contract" }, 409);
    if (!events) return c.json({ error: "Event store not configured" }, 503);

    const body = await c.req.json<{ type: string; payload?: Record<string, unknown> }>();
    if (!body.type?.trim()) return c.json({ error: "type is required" }, 400);
    if (body.type.startsWith("agreement.")) {
      return c.json({ error: "Event types starting with 'agreement.' are reserved" }, 400);
    }

    const parentId = await events.latestEventId(c.req.param("contractId"));
    const event: ContractEventRecord = {
      eventId: crypto.randomUUID(),
      contractId: c.req.param("contractId"),
      tenantId: tenant.tenantId,
      type: body.type,
      payload: body.payload ?? {},
      parentEventIds: parentId ? [parentId] : [],
      createdAt: Math.floor(Date.now() / 1000),
    };
    await events.append(event);
    return c.json(event, 201);
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
    negotiateEndpoint: `${baseUrl}/v1/${tenantId}/negotiate`,
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
