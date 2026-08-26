import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { openDb, credentialRepo, householdRepo, identityRepo } from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";
import { buildServer } from "../src/server.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let db: ReturnType<typeof openDb>;
let token: string;
let hh: HouseholdId;

// Token exchange runs through @googleapis/OAuth2Client → gaxios,
// not global fetch — intercept at the socket layer with MSW so the
// SDK's request resolves without hitting real Google.
const server = setupServer();

beforeAll(async () => {
  db = openDb({ url: ":memory:" });
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: "../../packages/db/migrations" });

  const identity = identityRepo(db);
  const m = identity.createManager({ displayName: "M", email: "m@a.b" });
  token = identity.mintToken({ actorType: "manager", actorId: m.id, label: "t" }).token;
  const household = householdRepo(db).create({ name: "H", tier: "life" });
  hh = household.id;
  identity.grantHousehold({ managerId: m.id, householdId: hh, role: "primary" });

  app = buildServer(db);
  await app.ready();

  server.listen({ onUnhandledRequest: "bypass" });
});

afterAll(async () => {
  server.close();
  await app.close();
});

beforeEach(() => {
  server.resetHandlers();
  vi.unstubAllEnvs();
  vi.stubEnv("ATELIER_OAUTH_STATE_SECRET", "test-state-secret-32-chars-long-a");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "cid");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "csec");
  vi.stubEnv("GOOGLE_OAUTH_REDIRECT_URI", "http://localhost:3001/oauth/google/callback");
  vi.stubEnv("ATELIER_CONSOLE_URL", "http://localhost:3000");
});

afterEach(() => {
  server.resetHandlers();
  vi.unstubAllEnvs();
});

describe("OAuth flow — Google", () => {
  it("reports configured when the four env vars are set", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/oauth/google/config",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.configured).toBe(true);
    expect(body.clientId).toBe(true);
    expect(body.clientSecret).toBe(true);
    expect(body.stateSecret).toBe(true);
    expect(body.scopes.join(" ")).toContain("gmail.send");
    expect(body.scopes.join(" ")).toContain("calendar");
  });

  it("400s the start endpoint when OAuth client is not configured", async () => {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "");
    const res = await app.inject({
      method: "POST",
      url: `/households/${hh}/oauth/google/start`,
      headers: { authorization: `Bearer ${token}` },
      payload: { returnTo: "http://localhost:3000/households/x" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("issues an authUrl with signed state and correct scopes", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/households/${hh}/oauth/google/start`,
      headers: { authorization: `Bearer ${token}` },
      payload: { returnTo: `http://localhost:3000/households/${hh}` },
    });
    expect(res.statusCode).toBe(200);
    const { authUrl } = res.json() as { authUrl: string };
    const url = new URL(authUrl);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.pathname).toBe("/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("scope")).toContain("gmail.send");
    expect(url.searchParams.get("state")).toBeTruthy();
    const state = url.searchParams.get("state")!;
    // state is "<b64url json>.<b64url sig>"
    expect(state.split(".")).toHaveLength(2);
  });

  it("completes the callback happy path: exchanges code, fetches userinfo, stores two credentials, redirects with oauth=ok", async () => {
    const start = await app.inject({
      method: "POST",
      url: `/households/${hh}/oauth/google/start`,
      headers: { authorization: `Bearer ${token}` },
      payload: { returnTo: `http://localhost:3000/households/${hh}` },
    });
    const state = new URL((start.json() as { authUrl: string }).authUrl).searchParams.get("state")!;

    server.use(
      http.post("https://oauth2.googleapis.com/token", async ({ request }) => {
        const body = await request.text();
        expect(body).toContain("code=code-abc");
        return HttpResponse.json({
          access_token: "at-abc",
          refresh_token: "rt-abc",
          expires_in: 3600,
          scope:
            "openid email profile https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.send",
        });
      }),
      http.get("https://openidconnect.googleapis.com/v1/userinfo", () =>
        HttpResponse.json({ email: "alex@example.com", name: "Alex Carrington" }),
      ),
    );

    const cb = await app.inject({
      method: "GET",
      url: `/oauth/google/callback?code=code-abc&state=${encodeURIComponent(state)}`,
    });
    expect(cb.statusCode).toBeGreaterThanOrEqual(300);
    expect(cb.statusCode).toBeLessThan(400);
    const location = cb.headers.location as string;
    expect(location).toContain("oauth=ok");
    expect(location).toContain("connected=");
    expect(location).toContain("google_calendar");
    expect(location).toContain("gmail");

    // Both credentials should now be stored.
    const stored = credentialRepo(db).list(hh);
    const google = stored.filter((c) => c.provider === "google_calendar" || c.provider === "gmail");
    expect(google.map((c) => c.provider).sort()).toEqual(["gmail", "google_calendar"]);
    const gmail = stored.find((c) => c.provider === "gmail");
    expect(gmail?.label).toContain("alex@example.com");
  });

  it("redirects with oauth=error on invalid state", async () => {
    const cb = await app.inject({
      method: "GET",
      url: `/oauth/google/callback?code=x&state=${encodeURIComponent("bad.state")}`,
    });
    expect(cb.headers.location).toContain("oauth=error");
    expect(cb.headers.location).toContain("invalid_state");
  });

  it("accepts state signed by the previous secret during rotation window", async () => {
    // Mint a state under the "old" (soon-to-be-rotated) secret.
    vi.stubEnv("ATELIER_OAUTH_STATE_SECRET", "old-secret-32-chars-long-abcdef01");
    const start = await app.inject({
      method: "POST",
      url: `/households/${hh}/oauth/google/start`,
      headers: { authorization: `Bearer ${token}` },
      payload: { returnTo: `http://localhost:3000/households/${hh}` },
    });
    const state = new URL((start.json() as { authUrl: string }).authUrl).searchParams.get("state")!;

    // Operator rotates: previous secret gets shifted to _PREVIOUS, a
    // fresh one takes the primary slot. The in-flight redirect still
    // needs to verify.
    vi.stubEnv("ATELIER_OAUTH_STATE_SECRET", "new-secret-32-chars-long-abcdef02");
    vi.stubEnv("ATELIER_OAUTH_STATE_SECRET_PREVIOUS", "old-secret-32-chars-long-abcdef01");

    server.use(
      http.post("https://oauth2.googleapis.com/token", () =>
        HttpResponse.json({
          access_token: "at-rot",
          refresh_token: "rt-rot",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/calendar",
        }),
      ),
      http.get("https://openidconnect.googleapis.com/v1/userinfo", () =>
        HttpResponse.json({ email: "rot@example.com" }),
      ),
    );

    const cb = await app.inject({
      method: "GET",
      url: `/oauth/google/callback?code=code-rot&state=${encodeURIComponent(state)}`,
    });
    expect(cb.headers.location).toContain("oauth=ok");
  });

  it("rejects state signed by an old secret once the rotation window is closed", async () => {
    vi.stubEnv("ATELIER_OAUTH_STATE_SECRET", "old-secret-32-chars-long-abcdef01");
    const start = await app.inject({
      method: "POST",
      url: `/households/${hh}/oauth/google/start`,
      headers: { authorization: `Bearer ${token}` },
      payload: { returnTo: `http://localhost:3000/households/${hh}` },
    });
    const state = new URL((start.json() as { authUrl: string }).authUrl).searchParams.get("state")!;

    // Rotation complete, previous secret unset — the old signature
    // must be rejected.
    vi.stubEnv("ATELIER_OAUTH_STATE_SECRET", "new-secret-32-chars-long-abcdef02");
    vi.stubEnv("ATELIER_OAUTH_STATE_SECRET_PREVIOUS", "");

    const cb = await app.inject({
      method: "GET",
      url: `/oauth/google/callback?code=x&state=${encodeURIComponent(state)}`,
    });
    expect(cb.headers.location).toContain("oauth=error");
    expect(cb.headers.location).toContain("invalid_state");
  });
});
