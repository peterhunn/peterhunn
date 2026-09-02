import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openDb, identityRepo } from "@atelier/db";
import { buildServer } from "../src/server.js";
import type { FastifyInstance } from "fastify";

let db: ReturnType<typeof openDb>;
let app: FastifyInstance;

beforeAll(async () => {
  db = openDb({ url: ":memory:" });
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: "../../packages/db/migrations" });
  app = buildServer(db);
  await app.ready();
});
afterAll(async () => await app.close());

const seedManagerWithToken = (opts: {
  email: string;
  ttlSeconds?: number;
  expiresAt?: string | null;
}): { token: string; tokenId: string; managerId: string } => {
  const identity = identityRepo(db);
  const m = identity.createManager({
    displayName: opts.email,
    email: opts.email,
  });
  const minted = identity.mintToken({
    actorType: "manager",
    actorId: m.id,
    label: "test",
    ...(opts.ttlSeconds !== undefined ? { ttlSeconds: opts.ttlSeconds } : {}),
    ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
  });
  return { token: minted.token, tokenId: minted.tokenId, managerId: m.id };
};

describe("bearer token lifecycle", () => {
  it("mint applies the 90-day default expiry when nothing is passed", () => {
    const { tokenId, managerId } = seedManagerWithToken({ email: "default@a.b" });
    const list = identityRepo(db).listTokens("manager", managerId);
    const target = list.find((t) => t.id === tokenId);
    expect(target).toBeDefined();
    expect(target!.expiresAt).not.toBeNull();
    const ttlMs = Date.parse(target!.expiresAt!) - Date.now();
    // ~90 days ±5s allowance
    expect(ttlMs).toBeGreaterThan(89 * 86400_000);
    expect(ttlMs).toBeLessThan(91 * 86400_000);
  });

  it("expired token → 401 with error: expired_token", async () => {
    const { token } = seedManagerWithToken({
      email: "expired@a.b",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("expired_token");
  });

  it("revoked token → 401 with error: revoked_token", async () => {
    const { token, tokenId } = seedManagerWithToken({ email: "revoked@a.b" });
    identityRepo(db).revokeToken(tokenId);
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("revoked_token");
  });

  it("unknown token → 401 with error: invalid_token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: "Bearer atl_definitely-not-real" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_token");
  });

  it("GET /me/tokens returns the actor's tokens (metadata only)", async () => {
    const { token } = seedManagerWithToken({ email: "list@a.b" });
    const res = await app.inject({
      method: "GET",
      url: "/me/tokens",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tokens.length).toBeGreaterThan(0);
    // Never leaks the hash or plaintext.
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/tokenHash/i);
    expect(raw).not.toContain(token);
  });

  it("POST /me/tokens/rotate revokes the caller and mints a fresh one", async () => {
    const { token: oldToken, tokenId: oldId } = seedManagerWithToken({
      email: "rotate@a.b",
    });
    const rotate = await app.inject({
      method: "POST",
      url: "/me/tokens/rotate",
      headers: { authorization: `Bearer ${oldToken}` },
      payload: {},
    });
    expect(rotate.statusCode).toBe(201);
    const body = rotate.json();
    expect(body.token).toMatch(/^atl_/);
    expect(body.tokenId).not.toBe(oldId);

    // Old token is now revoked.
    const oldCheck = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${oldToken}` },
    });
    expect(oldCheck.statusCode).toBe(401);
    expect(oldCheck.json().error).toBe("revoked_token");

    // New token works.
    const newCheck = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(newCheck.statusCode).toBe(200);
  });

  it("POST /me/tokens/:id/revoke refuses to revoke another actor's token", async () => {
    const a = seedManagerWithToken({ email: "a@x.y" });
    const b = seedManagerWithToken({ email: "b@x.y" });
    // A tries to revoke B's token by id.
    const res = await app.inject({
      method: "POST",
      url: `/me/tokens/${b.tokenId}/revoke`,
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(res.statusCode).toBe(404);
    // B's token still works.
    const bCheck = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(bCheck.statusCode).toBe(200);
  });

  it("POST /me/tokens/:id/revoke works when the actor owns the token", async () => {
    const { token, tokenId } = seedManagerWithToken({ email: "self@x.y" });
    const res = await app.inject({
      method: "POST",
      url: `/me/tokens/${tokenId}/revoke`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(204);
    const check = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(check.statusCode).toBe(401);
  });

  it("expiresAt: null explicit opt-out keeps a token eternal (used by seed)", () => {
    const identity = identityRepo(db);
    const m = identity.createManager({
      displayName: "Eternal",
      email: "eternal@x.y",
    });
    const minted = identity.mintToken({
      actorType: "manager",
      actorId: m.id,
      label: "seed",
      expiresAt: null,
    });
    const list = identity.listTokens("manager", m.id);
    const target = list.find((t) => t.id === minted.tokenId);
    expect(target!.expiresAt).toBeNull();
  });
});
