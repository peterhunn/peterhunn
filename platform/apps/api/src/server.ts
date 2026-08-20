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
import { peopleRoutes } from "./routes/people.js";
import { assetRoutes } from "./routes/assets.js";
import { graphByCategoryRoutes } from "./routes/graph-by-category.js";
import { documentRoutes } from "./routes/documents.js";
import { documentFileRoutes } from "./routes/document-files.js";

export const buildServer = (db: Db) => {
  // Global body limit — document uploads bump it above Fastify's
  // 1 MiB default. The per-route upload path also enforces the same
  // cap, so this is the outer sanity boundary.
  const maxUploadBytes = Number(
    process.env["ATELIER_MAX_UPLOAD_BYTES"] ?? 25 * 1024 * 1024,
  );
  const app = Fastify({
    logger: { level: process.env["LOG_LEVEL"] ?? "info" },
    bodyLimit: maxUploadBytes,
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
  app.register(peopleRoutes(db));
  app.register(assetRoutes(db));
  app.register(graphByCategoryRoutes(db));
  app.register(documentRoutes(db));
  app.register(documentFileRoutes(db));

  return app;
};
