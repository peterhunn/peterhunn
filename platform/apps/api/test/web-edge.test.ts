import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openDb } from "@atelier/db";
import { buildServer } from "../src/server.js";
import type { FastifyInstance } from "fastify";

let db: ReturnType<typeof openDb>;
let app: FastifyInstance;

beforeAll(async () => {
  db = openDb({ url: ":memory:" });
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: "../../packages/db/migrations" });
  process.env["ATELIER_CORS_ORIGINS"] =
    "https://console.atelier.example,https://staff.atelier.example";
  app = buildServer(db);
  await app.ready();
});
afterAll(async () => {
  delete process.env["ATELIER_CORS_ORIGINS"];
  await app.close();
});

describe("security headers + CORS", () => {
  it("helmet sets HSTS, nosniff, frame-options, and a locked CSP", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    // HSTS on every response — 6-month max-age with subdomains.
    expect(res.headers["strict-transport-security"]).toContain("max-age=15552000");
    expect(res.headers["strict-transport-security"]).toContain("includeSubDomains");
    // nosniff.
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    // Frame denial — nothing embeds our API.
    expect(res.headers["x-frame-options"]).toBe("DENY");
    // CSP: API-locked (no HTML surface).
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    // Referrer policy.
    expect(res.headers["referrer-policy"]).toBeDefined();
  });

  it("CORS reflects an allowed origin", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/healthz",
      headers: {
        origin: "https://console.atelier.example",
        "access-control-request-method": "GET",
      },
    });
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://console.atelier.example",
    );
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("CORS does not reflect a disallowed origin", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/healthz",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "GET",
      },
    });
    // @fastify/cors either omits the ACAO header or sets it to a
    // non-reflecting value for disallowed origins. Either way,
    // 'https://evil.example' should not appear.
    expect(res.headers["access-control-allow-origin"]).not.toBe(
      "https://evil.example",
    );
  });
});
