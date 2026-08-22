import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
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
import { peopleRoutes } from "./routes/people.js";
import { assetRoutes } from "./routes/assets.js";
import { graphByCategoryRoutes } from "./routes/graph-by-category.js";
import { documentRoutes } from "./routes/documents.js";
import { documentFileRoutes } from "./routes/document-files.js";
import { observabilityRoutes } from "./routes/observability.js";

export const buildServer = (db: Db) => {
  // Global body limit — document uploads bump it above Fastify's
  // 1 MiB default. The per-route upload path also enforces the same
  // cap, so this is the outer sanity boundary.
  const maxUploadBytes = Number(
    process.env["ATELIER_MAX_UPLOAD_BYTES"] ?? 25 * 1024 * 1024,
  );
  // Trust the reverse proxy's x-forwarded-for so rate limiting
  // keys on the real client IP behind fly.io / a CDN rather than
  // the proxy hop. Only trust one hop — deeper chains need a
  // number the operator sets deliberately.
  const app = Fastify({
    logger: { level: process.env["LOG_LEVEL"] ?? "info" },
    bodyLimit: maxUploadBytes,
    trustProxy: 1,
  });

  // Rate limits. Two tiers with per-route overrides:
  //   default: 120 req/min per (bearer-token OR client IP if
  //     no token). Comfortably above manual console clicks;
  //     catches a runaway browser tab or script.
  //   public webhooks: 60 req/min per IP. Enough for Twilio's
  //     legitimate retries; blocks unauthenticated flooding.
  //     Set on the specific routes below.
  // Health endpoint skips the counter — infra probes shouldn't
  // count against a limit.
  app.register(rateLimit, {
    global: true,
    max: Number(process.env["ATELIER_RATE_LIMIT_MAX"] ?? 120),
    timeWindow: process.env["ATELIER_RATE_LIMIT_WINDOW"] ?? "1 minute",
    // Key on the bearer token when present; fall back to IP so
    // an attacker can't dodge a per-IP limit by not sending a
    // token. Health path skipped entirely.
    keyGenerator: (req) => {
      const auth = req.headers["authorization"];
      if (typeof auth === "string" && auth.startsWith("Bearer ")) {
        return `tok:${auth.slice("Bearer ".length)}`;
      }
      return `ip:${req.ip}`;
    },
    // Skip health checks so uptime probes don't burn the budget.
    // /healthz is public and cheap; /messaging/inbound/* have
    // stricter per-route limits set at the route.
    skip: (req) => req.url === "/healthz",
    errorResponseBuilder: (_req, ctx) => ({
      error: "rate_limited",
      message: `Too many requests. Retry after ${ctx.after}.`,
      retryAfter: ctx.after,
    }),
  });

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

  // Catch-all binary parser for document file uploads. Anything
  // whose content-type isn't JSON or urlencoded (already parsed
  // above) is buffered raw so PUT
  // /households/:id/documents/:nodeId/file can hash + persist it.
  // Fastify calls this for octet-stream, image/*, application/pdf,
  // etc.  Size is enforced by the app-wide bodyLimit above.
  const rawBinaryParser = (
    _req: unknown,
    body: Buffer,
    done: (err: Error | null, body?: Buffer) => void,
  ): void => {
    done(null, body);
  };
  for (const mime of [
    "application/octet-stream",
    "application/pdf",
    "image/*",
    "text/plain",
  ]) {
    app.addContentTypeParser(mime, { parseAs: "buffer" }, rawBinaryParser as never);
  }

  app.register(authPlugin, { db });
  app.register(auditPlugin, { db });

  app.register(healthRoutes);
  app.register(meRoutes(db));
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
  app.register(peopleRoutes(db));
  app.register(assetRoutes(db));
  app.register(graphByCategoryRoutes(db));
  app.register(documentRoutes(db));
  app.register(documentFileRoutes(db));
  app.register(observabilityRoutes(db));

  return app;
};
