import Fastify from "fastify";
import type { Db } from "@atelier/db";
import "./types.js";
import { authPlugin } from "./auth.js";
import { auditPlugin } from "./audit.js";
import { healthRoutes } from "./routes/health.js";
import { meRoutes } from "./routes/me.js";
import { householdRoutes } from "./routes/households.js";
import { graphRoutes } from "./routes/graph.js";
import { auditRoutes } from "./routes/audit.js";
import { policyRoutes } from "./routes/policies.js";
import { orchestratorRoutes } from "./routes/orchestrator.js";
import { approvalRoutes } from "./routes/approvals.js";
import { modelRoutes } from "./routes/models.js";
import { inboxRoutes } from "./routes/inbox.js";
import { credentialRoutes } from "./routes/credentials.js";
import { oauthRoutes } from "./routes/oauth.js";
import { syncStateRoutes } from "./routes/sync-state.js";
import { calendarRoutes } from "./routes/calendar.js";
import { messagingRoutes } from "./routes/messaging.js";
import { playbookRoutes } from "./routes/playbooks.js";

export const buildServer = (db: Db) => {
  const app = Fastify({ logger: { level: process.env["LOG_LEVEL"] ?? "info" } });

  // Twilio webhooks POST application/x-www-form-urlencoded. Fastify
  // only parses JSON by default; register a minimal urlencoded
  // parser here so /messaging/inbound/twilio gets a Record<string,
  // string> body without pulling in @fastify/formbody.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        const params = new URLSearchParams(body as string);
        const out: Record<string, string> = {};
        for (const [k, v] of params) out[k] = v;
        done(null, out);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.register(authPlugin, { db });
  app.register(auditPlugin, { db });

  app.register(healthRoutes);
  app.register(meRoutes);
  app.register(householdRoutes(db));
  app.register(graphRoutes(db));
  app.register(auditRoutes(db));
  app.register(policyRoutes(db));
  app.register(orchestratorRoutes(db));
  app.register(approvalRoutes(db));
  app.register(modelRoutes(db));
  app.register(inboxRoutes(db));
  app.register(credentialRoutes(db));
  app.register(oauthRoutes(db));
  app.register(syncStateRoutes(db));
  app.register(calendarRoutes(db));
  app.register(messagingRoutes(db));
  app.register(playbookRoutes(db));

  return app;
};
