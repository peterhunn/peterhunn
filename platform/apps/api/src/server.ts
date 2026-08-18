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

  return app;
};
