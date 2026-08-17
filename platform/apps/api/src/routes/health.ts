import type { FastifyPluginAsync } from "fastify";

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/healthz", { config: { public: true } }, async () => ({
    ok: true,
    at: new Date().toISOString(),
  }));
};
