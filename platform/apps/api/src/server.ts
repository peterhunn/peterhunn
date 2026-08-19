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

export const buildServer = (db: Db) => {
  const app = Fastify({ logger: { level: process.env["LOG_LEVEL"] ?? "info" } });

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

  return app;
};
