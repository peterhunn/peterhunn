import type { FastifyPluginAsync } from "fastify";

// Whoami — the console calls this after login to render the header
// and to know which households the actor may see.
export const meRoutes: FastifyPluginAsync = async (app) => {
  app.get("/me", async (req) => ({ actor: req.actor }));
};
