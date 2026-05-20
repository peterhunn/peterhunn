import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import {
  requireContract,
  requireContractFetch,
  requireContractExpress,
  acceptHandler,
  verifyHandler,
  revokeHandler,
  discoveryHandler,
} from "../middleware.js";
import { signToken } from "../token.js";
import { InMemoryRevocationStore } from "../revocation.js";
import { InMemoryPendingContractStore } from "../pending.js";
import type { ContractRequirements, AcceptResponse, RevokeResponse, DiscoveryDocument } from "../types.js";
import type { ExpressLikeRequest, ExpressLikeResponse, ExpressNextFunction } from "../middleware.js";

const SECRET = "test-middleware-secret";
const NOW = Math.floor(Date.now() / 1000);

const requirements: ContractRequirements = {
  scheme: "x490",
  version: 1,
  templateId: "org.accordproject.test-nda",
  templateUrl: "https://example.com/template",
  templateHash: "deadbeef1234",
  requiredPartyFields: ["name"],
  acceptEndpoint: "https://example.com/accept",
  expiresIn: 3600,
  resource: "/data",
  description: "Test NDA",
  negotiable: true,
  negotiableFields: [
    { field: "jurisdiction", allowedValues: ["US", "UK"], description: "Governing jurisdiction" },
  ],
};

async function makeToken(overrides: { resource?: string; exp?: number } = {}) {
  return signToken(
    {
      contractId: "cid-test",
      templateHash: requirements.templateHash,
      partyId: "party-test",
      resource: overrides.resource ?? "/data",
      iat: NOW,
      exp: overrides.exp ?? NOW + 3600,
    },
    SECRET,
  );
}

function acceptBody(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    templateId: requirements.templateId,
    templateHash: requirements.templateHash,
    partyData: { name: "Test Party" },
    ...extra,
  });
}

// ── requireContract ────────────────────────────────────────────────────────────

describe("requireContract", () => {
  it("returns 490 when X-490-Contract header is absent", async () => {
    const app = new Hono();
    app.get("/data", requireContract({ requirements, secret: SECRET }), (c) => c.text("ok"));
    const res = await app.request("/data");
    assert.equal(res.status, 490);
    const body = await res.json() as { error: string };
    assert.ok(body.error.includes("Contract"));
  });

  it("returns 490 when token has wrong secret", async () => {
    const token = await signToken(
      { contractId: "c", templateHash: "h", partyId: "p", resource: "/data", iat: NOW, exp: NOW + 3600 },
      "wrong-secret",
    );
    const app = new Hono();
    app.get("/data", requireContract({ requirements, secret: SECRET }), (c) => c.text("ok"));
    const res = await app.request("/data", { headers: { "X-490-Contract": token } });
    assert.equal(res.status, 490);
  });

  it("returns 490 when token is expired", async () => {
    const token = await makeToken({ exp: NOW - 1 });
    const app = new Hono();
    app.get("/data", requireContract({ requirements, secret: SECRET }), (c) => c.text("ok"));
    const res = await app.request("/data", { headers: { "X-490-Contract": token } });
    assert.equal(res.status, 490);
  });

  it("passes through with a valid token and sets context vars", async () => {
    const token = await makeToken();
    const app = new Hono();
    app.get(
      "/data",
      requireContract({ requirements, secret: SECRET }),
      (c) => c.json({ contractId: c.var.x490ContractId, partyId: c.var.x490PartyId }),
    );
    const res = await app.request("/data", { headers: { "X-490-Contract": token } });
    assert.equal(res.status, 200);
    const body = await res.json() as { contractId: string; partyId: string };
    assert.equal(body.contractId, "cid-test");
    assert.equal(body.partyId, "party-test");
  });

  it("returns 490 for a revoked token", async () => {
    const revocationStore = new InMemoryRevocationStore();
    const token = await makeToken();
    await revocationStore.revoke("cid-test");

    const app = new Hono();
    app.get("/data", requireContract({ requirements, secret: SECRET, revocationStore }), (c) => c.text("ok"));
    const res = await app.request("/data", { headers: { "X-490-Contract": token } });
    assert.equal(res.status, 490);
    const body = await res.json() as { error: string };
    assert.ok(body.error.includes("revoked"));
  });
});

// ── acceptHandler ──────────────────────────────────────────────────────────────

describe("acceptHandler", () => {
  function makeApp(opts: Parameters<typeof acceptHandler>[0] = { requirements, secret: SECRET }) {
    const app = new Hono();
    app.post("/accept", acceptHandler(opts));
    return app;
  }

  it("returns 400 when templateHash mismatches", async () => {
    const app = makeApp();
    const res = await app.request("/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: requirements.templateId, templateHash: "wrong", partyData: { name: "A" } }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.ok(body.error.includes("templateHash"));
  });

  it("returns 400 when required partyData fields are missing", async () => {
    const app = makeApp();
    const res = await app.request("/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: requirements.templateId, templateHash: requirements.templateHash, partyData: {} }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string; missing: string[] };
    assert.ok(body.missing.includes("name"));
  });

  it("returns accepted with a token on valid request", async () => {
    const app = makeApp();
    const res = await app.request("/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: acceptBody(),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as AcceptResponse;
    assert.equal(body.status, "accepted");
    assert.ok(body.contractId.length > 0);
    assert.ok(body.token.length > 0);
  });

  it("calls onAccepted callback after acceptance", async () => {
    let called = false;
    const app = makeApp({
      requirements,
      secret: SECRET,
      onAccepted: async () => { called = true; },
    });
    await app.request("/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: acceptBody(),
    });
    assert.ok(called);
  });

  it("returns counter_offer when onNegotiation returns modified requirements", async () => {
    const counter = { ...requirements, jurisdiction: "UK" };
    const app = makeApp({
      requirements,
      secret: SECRET,
      onNegotiation: async () => counter,
    });
    const res = await app.request("/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: acceptBody({ negotiationTerms: { jurisdiction: "US" } }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as AcceptResponse;
    assert.equal(body.status, "counter_offer");
    assert.ok(body.counterOffer !== undefined);
  });

  it("accepts when onNegotiation returns undefined (accept as-is)", async () => {
    const app = makeApp({
      requirements,
      secret: SECRET,
      onNegotiation: async () => undefined,
    });
    const res = await app.request("/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: acceptBody({ negotiationTerms: { jurisdiction: "US" } }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as AcceptResponse;
    assert.equal(body.status, "accepted");
  });

  it("returns 400 when proposed field is not in negotiableFields", async () => {
    const app = makeApp();
    const res = await app.request("/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: acceptBody({ negotiationTerms: { confidentialityPeriod: 90 } }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string; invalidFields: string[] };
    assert.ok(body.invalidFields.includes("confidentialityPeriod"));
  });

  it("returns 400 when proposed value is not in allowedValues", async () => {
    const app = makeApp();
    const res = await app.request("/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: acceptBody({ negotiationTerms: { jurisdiction: "France" } }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string; field: string };
    assert.equal(body.field, "jurisdiction");
  });

  describe("multi-party", () => {
    const multiReq: ContractRequirements = { ...requirements, requiredParties: 2 };

    it("first signer gets status pending", async () => {
      const pendingStore = new InMemoryPendingContractStore();
      const app = new Hono();
      app.post("/accept", acceptHandler({ requirements: multiReq, secret: SECRET, pendingStore }));

      const res = await app.request("/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId: multiReq.templateId,
          templateHash: multiReq.templateHash,
          partyData: { name: "Party A" },
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as AcceptResponse;
      assert.equal(body.status, "pending");
      assert.equal(body.pendingAcceptances, 1);
      assert.equal(body.requiredAcceptances, 2);
    });

    it("second signer triggers acceptance and issues token", async () => {
      const pendingStore = new InMemoryPendingContractStore();
      const app = new Hono();
      app.post("/accept", acceptHandler({ requirements: multiReq, secret: SECRET, pendingStore }));

      const r1 = await app.request("/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId: multiReq.templateId,
          templateHash: multiReq.templateHash,
          partyData: { name: "Party A" },
        }),
      });
      const b1 = await r1.json() as AcceptResponse;
      assert.equal(b1.status, "pending");

      const r2 = await app.request("/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId: multiReq.templateId,
          templateHash: multiReq.templateHash,
          partyData: { name: "Party B" },
          pendingContractId: b1.contractId,
        }),
      });
      const b2 = await r2.json() as AcceptResponse;
      assert.equal(b2.status, "accepted");
      assert.ok(b2.token.length > 0);
    });

    it("returns 404 for unknown pendingContractId", async () => {
      const pendingStore = new InMemoryPendingContractStore();
      const app = new Hono();
      app.post("/accept", acceptHandler({ requirements: multiReq, secret: SECRET, pendingStore }));

      const res = await app.request("/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId: multiReq.templateId,
          templateHash: multiReq.templateHash,
          partyData: { name: "Party B" },
          pendingContractId: "does-not-exist",
        }),
      });
      assert.equal(res.status, 404);
    });
  });
});

// ── verifyHandler ──────────────────────────────────────────────────────────────

describe("verifyHandler", () => {
  it("returns 400 when token query param is absent", async () => {
    const app = new Hono();
    app.get("/verify", verifyHandler({ secret: SECRET }));
    const res = await app.request("/verify");
    assert.equal(res.status, 400);
  });

  it("returns valid=true for a good token", async () => {
    const token = await makeToken();
    const app = new Hono();
    app.get("/verify", verifyHandler({ secret: SECRET }));
    const res = await app.request(`/verify?token=${encodeURIComponent(token)}&resource=/data`);
    assert.equal(res.status, 200);
    const body = await res.json() as { valid: boolean; contractId: string };
    assert.ok(body.valid);
    assert.equal(body.contractId, "cid-test");
  });

  it("returns valid=false for an expired token", async () => {
    const token = await makeToken({ exp: NOW - 1 });
    const app = new Hono();
    app.get("/verify", verifyHandler({ secret: SECRET }));
    const res = await app.request(`/verify?token=${encodeURIComponent(token)}&resource=/data`);
    const body = await res.json() as { valid: boolean };
    assert.ok(!body.valid);
  });

  it("returns valid=false for a revoked token", async () => {
    const revocationStore = new InMemoryRevocationStore();
    await revocationStore.revoke("cid-test");
    const token = await makeToken();

    const app = new Hono();
    app.get("/verify", verifyHandler({ secret: SECRET, revocationStore }));
    const res = await app.request(`/verify?token=${encodeURIComponent(token)}&resource=/data`);
    const body = await res.json() as { valid: boolean; reason: string };
    assert.ok(!body.valid);
    assert.ok(body.reason.includes("revok"));
  });
});

// ── revokeHandler ──────────────────────────────────────────────────────────────

describe("revokeHandler", () => {
  it("returns 400 when contractId is missing", async () => {
    const store = new InMemoryRevocationStore();
    const app = new Hono();
    app.post("/revoke", revokeHandler({ revocationStore: store }));
    const res = await app.request("/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  it("revokes the contract and returns revoked=true", async () => {
    const store = new InMemoryRevocationStore();
    const app = new Hono();
    app.post("/revoke", revokeHandler({ revocationStore: store }));

    const res = await app.request("/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contractId: "cid-1", reason: "breach" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as RevokeResponse;
    assert.ok(body.revoked);
    assert.equal(body.contractId, "cid-1");
    assert.ok(await store.isRevoked("cid-1"));
  });

  it("returns 403 when onRevoke returns false", async () => {
    const store = new InMemoryRevocationStore();
    const app = new Hono();
    app.post("/revoke", revokeHandler({ revocationStore: store, onRevoke: async () => false }));

    const res = await app.request("/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contractId: "cid-1" }),
    });
    assert.equal(res.status, 403);
    assert.ok(!await store.isRevoked("cid-1"));
  });
});

// ── discoveryHandler ───────────────────────────────────────────────────────────

describe("discoveryHandler", () => {
  it("returns a DiscoveryDocument with scheme x490", async () => {
    const app = new Hono();
    app.get(
      "/.well-known/x490",
      discoveryHandler({
        origin: "https://api.example.com",
        resources: [
          { resource: "/data", description: "Test NDA", requirements },
        ],
      }),
    );
    const res = await app.request("/.well-known/x490");
    assert.equal(res.status, 200);
    const body = await res.json() as DiscoveryDocument;
    assert.equal(body.scheme, "x490");
    assert.equal(body.version, 1);
    assert.equal(body.origin, "https://api.example.com");
    assert.equal(body.resources.length, 1);
    assert.equal(body.resources[0]?.resource, "/data");
  });
});

// ── requireContractFetch ───────────────────────────────────────────────────────

describe("requireContractFetch", () => {
  it("returns ok:false with 490 when X-490-Contract header is absent", async () => {
    const check = requireContractFetch({ requirements, secret: SECRET });
    const request = new Request("https://api.example.com/data");
    const result = await check(request);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.response.status, 490);
      assert.ok(result.response.headers.get("X-490-Requirements"));
      const body = await result.response.json() as { error: string };
      assert.ok(body.error.includes("Contract"));
    }
  });

  it("returns ok:false when token is invalid", async () => {
    const check = requireContractFetch({ requirements, secret: SECRET });
    const request = new Request("https://api.example.com/data", {
      headers: { "X-490-Contract": "bad.token.value" },
    });
    const result = await check(request);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.response.status, 490);
    }
  });

  it("returns ok:true with contractId and partyId on valid token", async () => {
    const token = await makeToken();
    const check = requireContractFetch({ requirements, secret: SECRET });
    const request = new Request("https://api.example.com/data", {
      headers: { "X-490-Contract": token },
    });
    const result = await check(request);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.contractId, "cid-test");
      assert.equal(result.partyId, "party-test");
    }
  });
});

// ── requireContractExpress ─────────────────────────────────────────────────────

describe("requireContractExpress", () => {
  function makeExpressRes() {
    const calls: string[] = [];
    let jsonBody: unknown = null;
    let statusCode = 200;
    const res: ExpressLikeResponse = {
      status(code: number) { statusCode = code; return res; },
      set(_name: string, _value: string) { calls.push(_name); return res; },
      json(body: unknown) { jsonBody = body; },
    };
    return { res, calls, get statusCode() { return statusCode; }, get jsonBody() { return jsonBody; } };
  }

  it("calls next() on valid token and sets req fields", async () => {
    const token = await makeToken();
    const middleware = requireContractExpress({ requirements, secret: SECRET });

    const req: ExpressLikeRequest & Record<string, unknown> = {
      headers: { "x-490-contract": token },
      path: "/data",
    };
    const { res } = makeExpressRes();
    let nextCalled = false;
    const next: ExpressNextFunction = () => { nextCalled = true; };

    await middleware(req, res, next);

    assert.ok(nextCalled, "next() should have been called");
    assert.equal(req["x490ContractId"], "cid-test");
    assert.equal(req["x490PartyId"], "party-test");
  });

  it("returns 490 JSON when X-490-Contract header is absent", async () => {
    const middleware = requireContractExpress({ requirements, secret: SECRET });

    const req: ExpressLikeRequest & Record<string, unknown> = {
      headers: {},
      path: "/data",
    };
    const mock = makeExpressRes();
    let nextCalled = false;
    const next: ExpressNextFunction = () => { nextCalled = true; };

    await middleware(req, mock.res, next);

    assert.ok(!nextCalled, "next() should not have been called");
    assert.equal(mock.statusCode, 490);
    const body = mock.jsonBody as { error: string };
    assert.ok(body.error.includes("Contract"));
  });
});
