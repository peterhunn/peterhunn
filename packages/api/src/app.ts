import { Hono } from "hono";
import type { Context } from "hono";
import { ContractAgent } from "@legal-agents/agents";
import type { LLMClient } from "@legal-agents/agents";
import type { ContractRegistry } from "./registry.js";
import type { ContractStore } from "./store.js";

/**
 * Creates the Hono app with all contract routes.
 *
 * The app is runtime-agnostic — it works on Node.js, Cloudflare Workers, Bun,
 * and any other Hono-compatible runtime. Use startServer() for a Node.js process.
 *
 * Routes:
 *
 *   GET  /contracts                     list registered contract types
 *
 *   -- Type operations (stateless, no persistence) --
 *   POST /contracts/:type/draft         data → contract text
 *   POST /contracts/:type/parse         contract text → data
 *   POST /contracts/:type/analyze       contract text → ContractAnalysis
 *   POST /contracts/:type/compliance    contract text + requirements → ComplianceResult
 *   POST /contracts/:type/negotiate     contract text + perspective → suggestions
 *
 *   -- Instance operations (stateful, persisted in ContractStore) --
 *   POST /contracts/:type/activate      data → { contractId, state }
 *   GET  /contracts/:contractId/state   → { contractId, contractType, state }
 *   POST /contracts/:contractId/events  eventType + party → { state, result, emit? }
 */
export function createApp(
  registry: ContractRegistry,
  store: ContractStore,
  llm: LLMClient,
): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: err.message }, 500);
  });

  // ── Discovery ────────────────────────────────────────────────────────────

  app.get("/contracts", (c) => c.json({ types: registry.types() }));

  // ── Type operations ──────────────────────────────────────────────────────

  app.post("/contracts/:type/draft", async (c) => {
    const reg = registry.get(c.req.param("type"));
    if (!reg) return notFound(c, c.req.param("type"), registry);

    const body = await c.req.json<{ data: unknown }>();
    if (!reg.model.is(body.data)) {
      return c.json({ error: "Request body.data does not match the contract model" }, 400);
    }

    const agent = new ContractAgent(reg.template, reg.logic, llm);
    return c.json({ text: agent.draft(body.data) });
  });

  app.post("/contracts/:type/parse", async (c) => {
    const reg = registry.get(c.req.param("type"));
    if (!reg) return notFound(c, c.req.param("type"), registry);

    const { text } = await c.req.json<{ text: string }>();
    const agent = new ContractAgent(reg.template, reg.logic, llm);
    return c.json({ data: await agent.parse(text) });
  });

  app.post("/contracts/:type/analyze", async (c) => {
    const reg = registry.get(c.req.param("type"));
    if (!reg) return notFound(c, c.req.param("type"), registry);

    const { text } = await c.req.json<{ text: string }>();
    const agent = new ContractAgent(reg.template, reg.logic, llm);
    return c.json(await agent.analyze(text));
  });

  app.post("/contracts/:type/compliance", async (c) => {
    const reg = registry.get(c.req.param("type"));
    if (!reg) return notFound(c, c.req.param("type"), registry);

    const { text, requirements } = await c.req.json<{
      text: string;
      requirements: string[];
    }>();
    const agent = new ContractAgent(reg.template, reg.logic, llm);
    return c.json(await agent.checkCompliance(text, requirements));
  });

  app.post("/contracts/:type/negotiate", async (c) => {
    const reg = registry.get(c.req.param("type"));
    if (!reg) return notFound(c, c.req.param("type"), registry);

    const { text, perspective } = await c.req.json<{
      text: string;
      perspective?: "disclosing" | "receiving" | "neutral";
    }>();
    const agent = new ContractAgent(reg.template, reg.logic, llm);
    return c.json({ suggestions: await agent.negotiate(text, perspective) });
  });

  // ── Instance operations ──────────────────────────────────────────────────

  app.post("/contracts/:type/activate", async (c) => {
    const type = c.req.param("type");
    const reg = registry.get(type);
    if (!reg) return notFound(c, type, registry);

    const body = await c.req.json<{ data: unknown }>();
    if (!reg.model.is(body.data)) {
      return c.json({ error: "Request body.data does not match the contract model" }, 400);
    }

    const agent = new ContractAgent(reg.template, reg.logic, llm);
    const state = agent.activate(body.data);
    const contractId = state.stateId;

    await store.set(contractId, { contractType: type, data: body.data, state });
    return c.json({ contractId, state }, 201);
  });

  app.get("/contracts/:contractId/state", async (c) => {
    const contractId = c.req.param("contractId");
    const stored = await store.get(contractId);
    if (!stored) {
      return c.json({ error: `Contract not found: ${contractId}` }, 404);
    }
    return c.json({
      contractId,
      contractType: stored.contractType,
      state: stored.state,
    });
  });

  app.post("/contracts/:contractId/events", async (c) => {
    const contractId = c.req.param("contractId");
    const stored = await store.get(contractId);
    if (!stored) {
      return c.json({ error: `Contract not found: ${contractId}` }, 404);
    }

    const reg = registry.get(stored.contractType);
    if (!reg) {
      return c.json({ error: `Contract type '${stored.contractType}' is no longer registered` }, 500);
    }

    const body = await c.req.json<{
      eventType: string;
      party?: string;
      payload?: Record<string, unknown>;
    }>();

    // Build an event that satisfies ContractEvent and carries the type field
    // that contract-specific logic (e.g. NDA) uses for dispatch.
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

    return c.json({
      state: response.state,
      result: response.result,
      ...(response.emit ? { emit: response.emit } : {}),
    });
  });

  return app;
}

function notFound(c: Context, type: string, registry: ContractRegistry) {
  const registered = registry.types();
  return c.json(
    {
      error: `Unknown contract type: '${type}'.`,
      registered: registered.length > 0 ? registered : ["(none registered)"],
    },
    404,
  );
}
