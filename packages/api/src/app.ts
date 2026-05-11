import { Hono } from "hono";
import { ContractAgent } from "@legal-agents/agents";
import type { LLMClient } from "@legal-agents/agents";
import type { ContractRegistry } from "./registry.js";
import type { ContractStore } from "./store.js";
import type { ApiKeyStore } from "./auth.js";
import { hashApiKey } from "./auth.js";
import type { AuditLog } from "./audit.js";
import type { WebhookStore, WebhookEventType } from "./webhooks.js";
import { fanOut } from "./webhooks.js";

export interface AppOptions {
  registry: ContractRegistry;
  store: ContractStore;
  llm: LLMClient;
  apiKeys: ApiKeyStore;
  audit: AuditLog;
  webhooks: WebhookStore;
}

type AppVariables = {
  orgId: string;
  keyId: string;
  mode: "live" | "test";
};

/**
 * Creates the Hono app with auth, audit, webhooks, and all contract routes.
 *
 * Auth:     Authorization: Bearer sk_live_xxx  (required on every request)
 * Audit:    every state-changing call is recorded to the audit log
 * Webhooks: contract.activated / contract.event.processed fire after mutations
 *
 * Routes:
 *
 *   GET  /contracts                         list registered types
 *
 *   POST /contracts/:type/draft             data → text
 *   POST /contracts/:type/parse             text → data
 *   POST /contracts/:type/analyze           text → ContractAnalysis
 *   POST /contracts/:type/compliance        text + requirements → ComplianceResult
 *   POST /contracts/:type/negotiate         text + perspective? → suggestions
 *
 *   POST /contracts/:type/activate          data → { contractId, state }
 *   GET  /contracts/:contractId/state       → { contractId, contractType, state }
 *   POST /contracts/:contractId/events      eventType + party → { state, result }
 *   GET  /contracts/:contractId/audit       → AuditEntry[]
 *
 *   POST /keys                              create API key → { key, raw }
 *   GET  /keys                              list API keys
 *   DELETE /keys/:id                        revoke API key
 *
 *   POST /webhooks                          register webhook → { webhook, secret }
 *   GET  /webhooks                          list webhooks
 *   DELETE /webhooks/:id                    delete webhook
 */
export function createApp(options: AppOptions): Hono<{ Variables: AppVariables }> {
  const { registry, store, llm, apiKeys, audit, webhooks } = options;
  const app = new Hono<{ Variables: AppVariables }>();

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: err.message }, 500);
  });

  // ── Auth middleware ──────────────────────────────────────────────────────

  app.use("*", async (c, next) => {
    const header = c.req.header("Authorization");
    const raw = header?.startsWith("Bearer ") ? header.slice(7) : null;
    if (!raw) {
      return c.json(
        { error: "Missing Authorization header. Use: Authorization: Bearer sk_live_xxx" },
        401,
      );
    }
    const key = await apiKeys.findByRawKey(raw);
    if (!key) {
      return c.json({ error: "Invalid or revoked API key" }, 401);
    }
    c.set("orgId", key.orgId);
    c.set("keyId", key.id);
    c.set("mode", key.mode);
    await next();
  });

  // ── API key management ───────────────────────────────────────────────────

  app.post("/keys", async (c) => {
    const { name, mode = "live" } = await c.req.json<{
      name: string;
      mode?: "live" | "test";
    }>();
    const { key, raw } = await apiKeys.create(c.get("orgId"), name, mode);
    // Strip hash — never expose it in responses
    const { keyHash: _h, ...safeKey } = key;
    return c.json({ key: safeKey, raw }, 201);
  });

  app.get("/keys", async (c) => {
    const keys = await apiKeys.list(c.get("orgId"));
    return c.json({
      keys: keys.map(({ keyHash: _h, ...k }) => k),
    });
  });

  app.delete("/keys/:id", async (c) => {
    await apiKeys.revoke(c.req.param("id"));
    return c.json({ revoked: true });
  });

  // ── Webhook management ───────────────────────────────────────────────────

  app.post("/webhooks", async (c) => {
    const { url, events } = await c.req.json<{
      url: string;
      events: WebhookEventType[];
    }>();
    const hook = await webhooks.create(c.get("orgId"), url, events);
    // Secret is returned once here and never again
    return c.json({ webhook: hook }, 201);
  });

  app.get("/webhooks", async (c) => {
    const hooks = await webhooks.list(c.get("orgId"));
    // Omit secret from list responses
    return c.json({ webhooks: hooks.map(({ secret: _s, ...h }) => h) });
  });

  app.delete("/webhooks/:id", async (c) => {
    const hook = await webhooks.getById(c.req.param("id"));
    if (!hook || hook.orgId !== c.get("orgId")) {
      return c.json({ error: "Webhook not found" }, 404);
    }
    await webhooks.delete(c.req.param("id"));
    return c.json({ deleted: true });
  });

  // ── Discovery ────────────────────────────────────────────────────────────

  app.get("/contracts", (c) => c.json({ types: registry.types() }));

  // ── Type operations (stateless) ──────────────────────────────────────────

  app.post("/contracts/:type/draft", async (c) => {
    const reg = registry.get(c.req.param("type"));
    if (!reg) return typeNotFound(c, c.req.param("type"), registry);

    const { data } = await c.req.json<{ data: unknown }>();
    if (!reg.model.is(data)) {
      return c.json({ error: "body.data does not match the contract model" }, 400);
    }
    return c.json({ text: new ContractAgent(reg.template, reg.logic, llm).draft(data) });
  });

  app.post("/contracts/:type/parse", async (c) => {
    const reg = registry.get(c.req.param("type"));
    if (!reg) return typeNotFound(c, c.req.param("type"), registry);

    const { text } = await c.req.json<{ text: string }>();
    return c.json({ data: await new ContractAgent(reg.template, reg.logic, llm).parse(text) });
  });

  app.post("/contracts/:type/analyze", async (c) => {
    const reg = registry.get(c.req.param("type"));
    if (!reg) return typeNotFound(c, c.req.param("type"), registry);

    const { text } = await c.req.json<{ text: string }>();
    return c.json(await new ContractAgent(reg.template, reg.logic, llm).analyze(text));
  });

  app.post("/contracts/:type/compliance", async (c) => {
    const reg = registry.get(c.req.param("type"));
    if (!reg) return typeNotFound(c, c.req.param("type"), registry);

    const { text, requirements } = await c.req.json<{
      text: string;
      requirements: string[];
    }>();
    return c.json(
      await new ContractAgent(reg.template, reg.logic, llm).checkCompliance(text, requirements),
    );
  });

  app.post("/contracts/:type/negotiate", async (c) => {
    const reg = registry.get(c.req.param("type"));
    if (!reg) return typeNotFound(c, c.req.param("type"), registry);

    const { text, perspective } = await c.req.json<{
      text: string;
      perspective?: "disclosing" | "receiving" | "neutral";
    }>();
    return c.json({
      suggestions: await new ContractAgent(reg.template, reg.logic, llm).negotiate(
        text,
        perspective,
      ),
    });
  });

  // ── Instance operations (stateful) ───────────────────────────────────────

  app.post("/contracts/:type/activate", async (c) => {
    const type = c.req.param("type");
    const reg = registry.get(type);
    if (!reg) return typeNotFound(c, type, registry);

    const { data } = await c.req.json<{ data: unknown }>();
    if (!reg.model.is(data)) {
      return c.json({ error: "body.data does not match the contract model" }, 400);
    }

    const agent = new ContractAgent(reg.template, reg.logic, llm);
    const state = agent.activate(data);
    const contractId = state.stateId;
    const orgId = c.get("orgId");
    const keyId = c.get("keyId");

    await store.set(contractId, { orgId, contractType: type, data, state });

    await Promise.all([
      audit.record({
        orgId,
        keyId,
        contractId,
        action: "contract.activated",
        payload: { contractType: type },
      }),
      fanOut(webhooks, orgId, "contract.activated", {
        contractId,
        contractType: type,
        state,
      }),
    ]);

    return c.json({ contractId, state }, 201);
  });

  app.get("/contracts/:contractId/state", async (c) => {
    const contractId = c.req.param("contractId");
    const stored = await store.get(contractId, c.get("orgId"));
    if (!stored) return c.json({ error: `Contract not found: ${contractId}` }, 404);
    return c.json({ contractId, contractType: stored.contractType, state: stored.state });
  });

  app.post("/contracts/:contractId/events", async (c) => {
    const contractId = c.req.param("contractId");
    const orgId = c.get("orgId");
    const keyId = c.get("keyId");

    const stored = await store.get(contractId, orgId);
    if (!stored) return c.json({ error: `Contract not found: ${contractId}` }, 404);

    const reg = registry.get(stored.contractType);
    if (!reg) {
      return c.json({ error: `Contract type '${stored.contractType}' is no longer registered` }, 500);
    }

    const body = await c.req.json<{
      eventType: string;
      party?: string;
      payload?: Record<string, unknown>;
    }>();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const event: any = {
      $class: `${stored.contractType}.${body.eventType}`,
      eventId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      party: body.party,
      type: body.eventType,
      payload: body.payload ?? {},
    };

    const agent = new ContractAgent(reg.template, reg.logic, llm);
    const response = agent.execute(event, stored.state, stored.data as never);

    await store.set(contractId, { ...stored, state: response.state });

    const statusChanged = response.state.status !== stored.state.status;
    await Promise.all([
      audit.record({
        orgId,
        keyId,
        contractId,
        action: "contract.event.processed",
        payload: { eventType: body.eventType, party: body.party },
      }),
      fanOut(webhooks, orgId, "contract.event.processed", {
        contractId,
        eventType: body.eventType,
        result: response.result,
      }),
      statusChanged
        ? fanOut(webhooks, orgId, "contract.status.changed", {
            contractId,
            from: stored.state.status,
            to: response.state.status,
          })
        : Promise.resolve(),
    ]);

    return c.json({
      state: response.state,
      result: response.result,
      ...(response.emit ? { emit: response.emit } : {}),
    });
  });

  app.get("/contracts/:contractId/audit", async (c) => {
    const contractId = c.req.param("contractId");
    const orgId = c.get("orgId");

    // Verify the contract exists and belongs to this org before returning its log
    const stored = await store.get(contractId, orgId);
    if (!stored) return c.json({ error: `Contract not found: ${contractId}` }, 404);

    const entries = await audit.query(orgId, contractId);
    return c.json({ contractId, entries });
  });

  return app;
}

import type { Context } from "hono";
function typeNotFound(
  c: Context,
  type: string,
  registry: ContractRegistry,
) {
  const registered = registry.types();
  return c.json(
    {
      error: `Unknown contract type: '${type}'.`,
      registered: registered.length > 0 ? registered : [],
    },
    404,
  );
}
