import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import type { Db } from "@atelier/db";
import "./types.js";
import { authPlugin } from "./auth.js";
import { auditPlugin } from "./audit.js";
import { healthRoutes } from "./routes/health.js";
import { meRoutes } from "./routes/me.js";
import { webauthnRoutes } from "./routes/webauthn.js";
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
import { customerActivityRoutes } from "./routes/customer-activity.js";
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
    // Trust one reverse-proxy hop so rate-limit keys off the real
    // client IP behind fly.io / a CDN rather than the proxy's own
    // address. Fastify's typing wants the numeric hop count as a
    // string via its options bag; the underlying `proxy-addr`
    // accepts either.
    trustProxy: "1",
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
    allowList: (req) => req.url === "/healthz",
    errorResponseBuilder: (_req, ctx) => {
      // The plugin THROWS whatever we return here; Fastify's
      // default error handler serializes `{ statusCode, error,
      // message, code }` from an Error's own properties, so we
      // return an Error subtype with the right shape rather than
      // a bare object (which Fastify would treat as an unknown
      // error and default to 500 with "Internal Server Error").
      const err = new Error(
        `Too many requests. Retry after ${ctx.after}.`,
      ) as Error & {
        statusCode: number;
        code: string;
        retryAfter: string;
      };
      err.statusCode = ctx.statusCode;
      err.code = "RATE_LIMITED";
      err.retryAfter = ctx.after;
      return err;
    },
  });

  // Reshape rate-limit errors into the { error: "rate_limited" }
  // envelope the rest of the API uses. Everything else falls
  // through to Fastify's default (which serializes as
  // { statusCode, error, message } with `error` set to the HTTP
  // reason phrase — fine for generic 4xx/5xx).
  app.setErrorHandler((err, req, reply) => {
    const anyErr = err as Error & {
      statusCode?: number;
      code?: string;
      retryAfter?: string;
    };
    if (anyErr.code === "RATE_LIMITED") {
      return reply.code(anyErr.statusCode ?? 429).send({
        error: "rate_limited",
        message: anyErr.message,
        ...(anyErr.retryAfter ? { retryAfter: anyErr.retryAfter } : {}),
      });
    }
    reply.send(anyErr);
    void req;
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
    "text/plain",
  ]) {
    app.addContentTypeParser(mime, { parseAs: "buffer" }, rawBinaryParser as never);
  }
  // Fastify's addContentTypeParser takes a string (exact match) or a
  // RegExp — the "image/*" wildcard string does NOT expand, it just
  // fails to match "image/jpeg" / "image/png" and Fastify replies 415.
  // Register a regex so every image/* mime routes to the same raw
  // buffer parser.
  app.addContentTypeParser(
    /^image\//,
    { parseAs: "buffer" },
    rawBinaryParser as never,
  );

  // Security headers (helmet) + CORS. Both must land before any
  // route handlers, so register them right after the body parsers
  // and before auth.
  //
  // Helmet defaults: X-Content-Type-Options nosniff, X-Frame-
  // Options DENY, Strict-Transport-Security (HSTS) with a 6-month
  // max-age + subdomains, Referrer-Policy no-referrer, and a
  // strict Content-Security-Policy that forbids inline scripts.
  // The API doesn't serve HTML, so CSP is API-appropriate (no
  // sources for anything).
  //
  // Behind a reverse proxy that already terminates TLS (fly.io,
  // Cloudflare), HSTS still helps because the browser follows the
  // header from the first HTTPS response.
  app.register(helmet, {
    global: true,
    // API-shaped CSP: no HTML rendering surface, so lock everything.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    // API surface never gets framed anywhere; DENY is stricter
    // than helmet's SAMEORIGIN default and appropriate here.
    xFrameOptions: { action: "deny" },
    // Strict-Transport-Security — 6-month max-age with subdomains.
    // includeSubDomains is safe for atelier-api.fly.dev today; if
    // we ever host non-HTTPS content on a subdomain, set to false.
    strictTransportSecurity: {
      maxAge: 15_552_000,
      includeSubDomains: true,
      preload: false,
    },
    // Cross-origin resource sharing headers separately handled by
    // @fastify/cors below; helmet's default COEP/COOP are strict
    // and can break OAuth popup flows, so relax them here.
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
  });

  // CORS — explicit origin allowlist. Comma-separated in
  // ATELIER_CORS_ORIGINS; falls back to the console URL for dev
  // convenience. Credentials never allowed with a wildcard.
  const originsEnv = process.env["ATELIER_CORS_ORIGINS"];
  const consoleUrl = process.env["ATELIER_CONSOLE_URL"] ?? "http://localhost:3000";
  const originAllowlist = originsEnv
    ? originsEnv.split(",").map((s) => s.trim()).filter(Boolean)
    : [consoleUrl];
  app.register(cors, {
    origin: originAllowlist,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // Public webhooks (Twilio, Google OAuth callback) are hit
    // server-to-server, not from a browser, so they don't need
    // CORS to work. Leaving them in the same policy is fine.
  });

  app.register(authPlugin, { db });
  app.register(auditPlugin, { db });

  app.register(healthRoutes);
  app.register(meRoutes(db));
  app.register(webauthnRoutes(db));
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
  app.register(customerActivityRoutes(db));
  app.register(assetRoutes(db));
  app.register(graphByCategoryRoutes(db));
  app.register(documentRoutes(db));
  app.register(documentFileRoutes(db));
  app.register(observabilityRoutes(db));

  return app;
};
