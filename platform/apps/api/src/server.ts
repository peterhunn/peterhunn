import Fastify from "fastify";
import type { Db } from "@atelier/db";
import { healthRoutes } from "./routes/health.js";
import { householdRoutes } from "./routes/households.js";
import { graphRoutes } from "./routes/graph.js";

export const buildServer = (db: Db) => {
  const app = Fastify({ logger: { level: process.env["LOG_LEVEL"] ?? "info" } });

  app.register(healthRoutes);
  app.register(householdRoutes(db));
  app.register(graphRoutes(db));

  return app;
};
