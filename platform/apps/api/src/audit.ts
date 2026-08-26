import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { auditRepo, type Db } from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";

// Emits an audit event for every request that touched a specific
// household. Reads and writes both. Routes may set reply.header
// 'x-atelier-resource-id' / 'x-atelier-resource-type' to attribute the
// event more precisely; otherwise we log at household granularity.
// Routes that need to attach structured decision context to the
// audit metadata (e.g. "which fields were accepted from an LLM
// extraction proposal") assign `req.auditMetadata = {...}` before
// returning; the hook merges it under a `route` key on top of the
// default `{method, url, status}` envelope.
declare module "fastify" {
  interface FastifyContextConfig {
    audit?: {
      action?: string;
      resourceType?: string;
      sensitive?: boolean;
    };
  }
  interface FastifyRequest {
    auditMetadata?: Record<string, unknown>;
  }
}

export interface AuditPluginOpts {
  readonly db: Db;
}

const plugin: FastifyPluginAsync<AuditPluginOpts> = async (app, opts) => {
  const audit = auditRepo(opts.db);

  app.addHook("onResponse", async (req, reply) => {
    if (reply.statusCode >= 400) return;
    if (!req.householdContext) return;
    if (!req.actor) return;

    const cfg = req.routeOptions.config?.audit;
    const action =
      cfg?.action ?? `${req.method.toLowerCase()}:${req.routeOptions.url ?? req.url}`;
    const resourceType = cfg?.resourceType ?? "household";

    const params = req.params as Record<string, string> | undefined;
    const resourceId =
      params?.["nodeId"] ??
      params?.["edgeId"] ??
      params?.["actionId"] ??
      params?.["householdId"] ??
      req.householdContext;

    audit.record({
      householdId: req.householdContext as HouseholdId,
      actor: req.actor,
      action,
      resourceType,
      resourceId,
      sensitive: cfg?.sensitive ?? false,
      metadata: {
        method: req.method,
        url: req.url,
        status: reply.statusCode,
        ...(req.auditMetadata ? { route: req.auditMetadata } : {}),
      },
    });
  });
};

export const auditPlugin = fp(plugin, { name: "atelier-audit" });
