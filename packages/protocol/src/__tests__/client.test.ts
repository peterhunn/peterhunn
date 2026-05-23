import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ContractClient } from "../client.js";
import { signToken } from "../token.js";
import { b64encode } from "../codec.js";
import type { ContractRequirements, AcceptRequest, AcceptResponse, X402Response } from "../types.js";

const SECRET = "client-test-secret";
const NOW = Math.floor(Date.now() / 1000);

const requirements: ContractRequirements = {
  scheme: "x490",
  version: 1,
  templateId: "org.accordproject.test",
  templateUrl: "https://api.example.com/template",
  templateHash: "testhash123",
  requiredPartyFields: ["name"],
  acceptEndpoint: "https://api.example.com/accept",
  expiresIn: 3600,
  resource: "/resource",
  description: "Test contract",
  negotiable: false,
};

async function freshToken() {
  return signToken(
    { contractId: "cid-fresh", templateHash: requirements.templateHash, partyId: "test-party", resource: "/resource", iat: NOW, exp: NOW + 3600 },
    SECRET,
  );
}

// ── fetch mock infrastructure ──────────────────────────────────────────────────

type FetchImpl = typeof globalThis.fetch;
let originalFetch: FetchImpl;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    return handler(input.toString(), init);
  };
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe("ContractClient.fetch", () => {
  it("passes through a 200 response unchanged", async () => {
    mockFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const client = new ContractClient({ partyData: { name: "Test" } });
    const res = await client.fetch("https://api.example.com/resource");
    assert.equal(res.status, 200);
  });

  it("handles a 490 response by establishing agreement and retrying", async () => {
    let calls = 0;
    const token = await freshToken();
    const reqHeader = b64encode(JSON.stringify(requirements));

    mockFetch(async (url) => {
      calls++;
      if (url.includes("/accept")) {
        const resp: AcceptResponse = { status: "accepted", contractId: "cid-1", token };
        return new Response(JSON.stringify(resp), { status: 200 });
      }
      if (calls === 1) {
        return new Response(JSON.stringify({ error: "contract required" }), {
          status: 490,
          headers: { "X-490-Requirements": reqHeader },
        });
      }
      return new Response(JSON.stringify({ data: "success" }), { status: 200 });
    });

    const client = new ContractClient({ partyData: { name: "Test" }, skipTemplateVerification: true });
    const res = await client.fetch("https://api.example.com/resource");
    assert.equal(res.status, 200);
  });

  it("returns the 490 as-is when X-490-Requirements header is absent", async () => {
    mockFetch(() => new Response(JSON.stringify({ error: "nope" }), { status: 490 }));

    const client = new ContractClient({ partyData: { name: "Test" } });
    const res = await client.fetch("https://api.example.com/resource");
    assert.equal(res.status, 490);
  });

  it("handles a 402 with contractRequired by establishing agreement", async () => {
    const token = await freshToken();
    let acceptCalled = false;

    mockFetch(async (url) => {
      if (url.includes("/accept")) {
        acceptCalled = true;
        const resp: AcceptResponse = { status: "accepted", contractId: "cid-1", token };
        return new Response(JSON.stringify(resp), { status: 200 });
      }
      const body: X402Response = {
        x402Version: 1,
        accepts: [],
        contractRequired: requirements,
        error: null,
      };
      return new Response(JSON.stringify(body), { status: 402 });
    });

    const client = new ContractClient({ partyData: { name: "Test" }, skipTemplateVerification: true });
    const res = await client.fetch("https://api.example.com/resource");
    assert.equal(res.status, 402);
    assert.ok(acceptCalled, "should have called accept endpoint");
  });

  it("passes through a 402 without contractRequired unchanged", async () => {
    let acceptCalled = false;
    mockFetch(async (url) => {
      if (url.includes("/accept")) { acceptCalled = true; }
      return new Response(JSON.stringify({ x402Version: 1, accepts: [], error: null }), { status: 402 });
    });

    const client = new ContractClient({ partyData: { name: "Test" } });
    const res = await client.fetch("https://api.example.com/resource");
    assert.equal(res.status, 402);
    assert.ok(!acceptCalled);
  });
});

describe("ContractClient.establishAgreement", () => {
  it("returns a token on successful acceptance", async () => {
    const token = await freshToken();
    mockFetch(async () => {
      const resp: AcceptResponse = { status: "accepted", contractId: "cid-1", token };
      return new Response(JSON.stringify(resp), { status: 200 });
    });

    const client = new ContractClient({ partyData: { name: "Test" }, skipTemplateVerification: true });
    const result = await client.establishAgreement(requirements);
    assert.equal(result, token);
  });

  it("returns cached token on second call without fetching again", async () => {
    const token = await freshToken();
    let fetchCount = 0;
    mockFetch(async () => {
      fetchCount++;
      const resp: AcceptResponse = { status: "accepted", contractId: "cid-1", token };
      return new Response(JSON.stringify(resp), { status: 200 });
    });

    const client = new ContractClient({ partyData: { name: "Test" }, skipTemplateVerification: true });
    await client.establishAgreement(requirements);
    await client.establishAgreement(requirements);
    assert.equal(fetchCount, 1);
  });

  it("refreshes when cached token is within the refresh threshold", async () => {
    // Token that expires in 30 seconds — within the default 60s threshold
    const nearExpiryToken = await signToken(
      { contractId: "cid-ne", templateHash: requirements.templateHash, partyId: "p", resource: "/resource", iat: NOW, exp: NOW + 30 },
      SECRET,
    );
    const freshTok = await freshToken();
    let fetchCount = 0;

    mockFetch(async () => {
      fetchCount++;
      const resp: AcceptResponse = { status: "accepted", contractId: "cid-ne2", token: fetchCount === 1 ? nearExpiryToken : freshTok };
      return new Response(JSON.stringify(resp), { status: 200 });
    });

    const client = new ContractClient({ partyData: { name: "Test" }, skipTemplateVerification: true });
    const t1 = await client.establishAgreement(requirements);
    // t1 is near-expiry — second call should re-fetch
    const t2 = await client.establishAgreement(requirements);
    assert.equal(t1, nearExpiryToken);
    assert.equal(t2, freshTok);
    assert.equal(fetchCount, 2);
  });

  it("does not refresh when cached token exceeds the refresh threshold", async () => {
    // Token that expires in 90 seconds — outside the default 60s threshold
    const longerToken = await signToken(
      { contractId: "cid-lt", templateHash: requirements.templateHash, partyId: "p", resource: "/resource", iat: NOW, exp: NOW + 90 },
      SECRET,
    );
    let fetchCount = 0;

    mockFetch(async () => {
      fetchCount++;
      const resp: AcceptResponse = { status: "accepted", contractId: "cid-lt", token: longerToken };
      return new Response(JSON.stringify(resp), { status: 200 });
    });

    const client = new ContractClient({ partyData: { name: "Test" }, skipTemplateVerification: true });
    await client.establishAgreement(requirements);
    await client.establishAgreement(requirements);
    assert.equal(fetchCount, 1);
  });

  it("respects a custom tokenRefreshThreshold", async () => {
    // Token expires in 45 seconds; with a 30s threshold it should NOT refresh
    const midToken = await signToken(
      { contractId: "cid-mid", templateHash: requirements.templateHash, partyId: "p", resource: "/resource", iat: NOW, exp: NOW + 45 },
      SECRET,
    );
    let fetchCount = 0;

    mockFetch(async () => {
      fetchCount++;
      const resp: AcceptResponse = { status: "accepted", contractId: "cid-mid", token: midToken };
      return new Response(JSON.stringify(resp), { status: 200 });
    });

    const client = new ContractClient({ partyData: { name: "Test" }, skipTemplateVerification: true, tokenRefreshThreshold: 30 });
    await client.establishAgreement(requirements);
    await client.establishAgreement(requirements);
    assert.equal(fetchCount, 1);
  });

  it("handles a counter-offer round-trip and accepts", async () => {
    const token = await freshToken();
    const counter: ContractRequirements = { ...requirements, jurisdiction: "UK", templateHash: "testhash123" };
    let round = 0;

    mockFetch(async () => {
      round++;
      if (round === 1) {
        const resp: AcceptResponse = { status: "counter_offer", contractId: "cid-tmp", token: "", counterOffer: counter };
        return new Response(JSON.stringify(resp), { status: 200 });
      }
      const resp: AcceptResponse = { status: "accepted", contractId: "cid-1", token };
      return new Response(JSON.stringify(resp), { status: 200 });
    });

    const client = new ContractClient({ partyData: { name: "Test" }, maxNegotiationRounds: 3, skipTemplateVerification: true });
    const result = await client.establishAgreement(requirements);
    assert.equal(result, token);
    assert.equal(round, 2);
  });

  it("throws when max negotiation rounds are exceeded", async () => {
    const counter: ContractRequirements = { ...requirements, jurisdiction: "UK" };
    mockFetch(async () => {
      const resp: AcceptResponse = { status: "counter_offer", contractId: "cid-tmp", token: "", counterOffer: counter };
      return new Response(JSON.stringify(resp), { status: 200 });
    });

    const client = new ContractClient({ partyData: { name: "Test" }, maxNegotiationRounds: 2, skipTemplateVerification: true });
    await assert.rejects(
      () => client.establishAgreement(requirements),
      /exceeded/,
    );
  });

  it("throws when accept endpoint returns non-ok status", async () => {
    mockFetch(async () => new Response("Internal Server Error", { status: 500 }));

    const client = new ContractClient({ partyData: { name: "Test" }, skipTemplateVerification: true });
    await assert.rejects(
      () => client.establishAgreement(requirements),
      /accept failed/,
    );
  });

  it("calls onRequirements callback before accepting", async () => {
    const token = await freshToken();
    let inspected: ContractRequirements | null = null;
    mockFetch(async () => {
      const resp: AcceptResponse = { status: "accepted", contractId: "cid-1", token };
      return new Response(JSON.stringify(resp), { status: 200 });
    });

    const client = new ContractClient({
      partyData: { name: "Test" },
      skipTemplateVerification: true,
      onRequirements: async (req) => { inspected = req; },
    });
    await client.establishAgreement(requirements);
    assert.ok(inspected !== null);
    assert.equal((inspected as ContractRequirements).templateId, requirements.templateId);
  });
});

describe("ContractClient template hash verification", () => {
  it("accepts when template content matches the declared hash", async () => {
    const templateContent = "This is the contract template.";
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(templateContent));
    const templateHash = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const token = await signToken(
      { contractId: "cid-v", templateHash, partyId: "p", resource: "/resource", iat: NOW, exp: NOW + 3600 },
      SECRET,
    );

    const req: ContractRequirements = { ...requirements, templateHash };
    mockFetch(async (url) => {
      if (url.includes("/template")) return new Response(templateContent, { status: 200 });
      const resp: AcceptResponse = { status: "accepted", contractId: "cid-v", token };
      return new Response(JSON.stringify(resp), { status: 200 });
    });

    const client = new ContractClient({ partyData: { name: "Test" } });
    const result = await client.establishAgreement(req);
    assert.equal(result, token);
  });

  it("throws when template content does not match the declared hash", async () => {
    const req: ContractRequirements = { ...requirements, templateHash: "a".repeat(64) };
    mockFetch(async (url) => {
      if (url.includes("/template")) return new Response("tampered content", { status: 200 });
      const resp: AcceptResponse = { status: "accepted", contractId: "cid-x", token: "t" };
      return new Response(JSON.stringify(resp), { status: 200 });
    });

    const client = new ContractClient({ partyData: { name: "Test" } });
    await assert.rejects(
      () => client.establishAgreement(req),
      /hash mismatch/,
    );
  });

  it("fetches the template only once across multiple calls with the same hash", async () => {
    const templateContent = "Stable template.";
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(templateContent));
    const templateHash = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const token = await signToken(
      { contractId: "cid-c", templateHash, partyId: "p", resource: "/resource", iat: NOW, exp: NOW + 3600 },
      SECRET,
    );

    let templateFetches = 0;
    const req: ContractRequirements = { ...requirements, templateHash };
    mockFetch(async (url) => {
      if (url.includes("/template")) {
        templateFetches++;
        return new Response(templateContent, { status: 200 });
      }
      const resp: AcceptResponse = { status: "accepted", contractId: "cid-c", token };
      return new Response(JSON.stringify(resp), { status: 200 });
    });

    const client = new ContractClient({ partyData: { name: "Test" } });
    // Second call uses cached token, so only one template fetch total
    await client.establishAgreement(req);
    await client.establishAgreement(req);
    assert.equal(templateFetches, 1);
  });
});

describe("ContractClient negotiateEndpoint routing", () => {
  const negotiableReqs: ContractRequirements = {
    ...requirements,
    negotiable: true,
    negotiableFields: [
      { field: "jurisdiction", allowedValues: ["US", "UK"], description: "Jurisdiction" },
    ],
    acceptEndpoint: "https://api.example.com/accept",
    negotiateEndpoint: "https://api.example.com/negotiate",
  };

  it("posts to negotiateEndpoint when negotiationTerms are present and endpoint exists", async () => {
    const token = await freshToken();
    let hitUrl = "";

    mockFetch(async (url) => {
      hitUrl = url;
      const resp: AcceptResponse = { status: "accepted", contractId: "cid-neg", token };
      return new Response(JSON.stringify(resp), { status: 200 });
    });

    const client = new ContractClient({
      partyData: { name: "Test" },
      skipTemplateVerification: true,
      onNegotiation: async () => ({ jurisdiction: "US" }),
    });
    await client.establishAgreement(negotiableReqs);
    assert.equal(hitUrl, "https://api.example.com/negotiate");
  });

  it("falls back to acceptEndpoint when negotiationTerms are absent", async () => {
    const token = await freshToken();
    let hitUrl = "";

    mockFetch(async (url) => {
      hitUrl = url;
      const resp: AcceptResponse = { status: "accepted", contractId: "cid-acc", token };
      return new Response(JSON.stringify(resp), { status: 200 });
    });

    const client = new ContractClient({
      partyData: { name: "Test" },
      skipTemplateVerification: true,
      // No onNegotiation — no negotiationTerms sent
    });
    await client.establishAgreement(negotiableReqs);
    assert.equal(hitUrl, "https://api.example.com/accept");
  });

  it("uses acceptEndpoint when negotiationTerms are present but no negotiateEndpoint", async () => {
    const { negotiateEndpoint: _ne, ...reqs } = negotiableReqs;
    const token = await freshToken();
    let hitUrl = "";

    mockFetch(async (url) => {
      hitUrl = url;
      const resp: AcceptResponse = { status: "accepted", contractId: "cid-a2", token };
      return new Response(JSON.stringify(resp), { status: 200 });
    });

    const client = new ContractClient({
      partyData: { name: "Test" },
      skipTemplateVerification: true,
      onNegotiation: async () => ({ jurisdiction: "UK" }),
    });
    await client.establishAgreement(reqs);
    assert.equal(hitUrl, "https://api.example.com/accept");
  });
});

describe("ContractClient partyData pre-validation", () => {
  it("throws when required party fields are missing from partyData", async () => {
    const reqWithFields: ContractRequirements = {
      ...requirements,
      requiredPartyFields: ["name", "org"],
    };

    const client = new ContractClient({
      partyData: {},
      skipTemplateVerification: true,
    });

    await assert.rejects(
      () => client.establishAgreement(reqWithFields),
      /missing required party fields/,
    );
  });
});

describe("ContractClient checkRevocationOnUse", () => {
  const verifyEndpointReqs: ContractRequirements = {
    ...requirements,
    verifyEndpoint: "https://facilitator.example.com/v1/tenant1/verify",
  };

  it("when checkRevocationOnUse is true and verify returns { valid: false } — token is evicted, onRevoked fires, client re-establishes", async () => {
    const staleToken = await signToken(
      { contractId: "cid-revoked-check", templateHash: verifyEndpointReqs.templateHash, partyId: "p", resource: "/resource", iat: NOW, exp: NOW + 3600 },
      SECRET,
    );
    const freshTok = await freshToken();
    const reqHeader = b64encode(JSON.stringify(verifyEndpointReqs));
    let revokedId: string | null = null;
    let acceptCalls = 0;
    let resourceCalls = 0;
    let verifyCalls = 0;
    // Phase 1: first call to /accept returns the stale token, priming the verifyEndpointByHash map
    // Phase 2: verify returns { valid: false }, token is evicted, onRevoked fires
    // Phase 3: 490 flow re-establishes with a fresh token via a second /accept call
    let acceptPhase = 0;

    mockFetch(async (url) => {
      if (url.includes("/verify")) {
        verifyCalls++;
        return new Response(JSON.stringify({ valid: false }), { status: 200 });
      }
      if (url.includes("/accept")) {
        acceptCalls++;
        acceptPhase++;
        const token = acceptPhase === 1 ? staleToken : freshTok;
        const contractId = acceptPhase === 1 ? "cid-revoked-check" : "cid-new-check";
        const resp: AcceptResponse = { status: "accepted", contractId, token };
        return new Response(JSON.stringify(resp), { status: 200 });
      }
      resourceCalls++;
      if (resourceCalls === 1) {
        return new Response(null, { status: 490, headers: { "X-490-Requirements": reqHeader } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const client = new ContractClient({
      partyData: { name: "Test" },
      skipTemplateVerification: true,
      checkRevocationOnUse: true,
      onRevoked: (id) => { revokedId = id; },
    });

    // First call: no cached token → 490 flow → establishes agreement (staleToken) + primes verifyEndpointByHash
    // Second call: has cached staleToken → checkRevocationOnUse triggers verify → { valid: false }
    //              → evict staleToken + fire onRevoked → 490 flow re-establishes with freshTok
    const res = await client.fetch("https://api.example.com/resource");
    assert.equal(res.status, 200);
    // First request hit 490 (resourceCalls === 1), triggered accept (acceptCalls === 1 after phase 1 setup)
    // Second request (retry after 490) succeeded — but we need a second client.fetch call to trigger revocation check
    // Reset resourceCalls and call again to trigger the revocation path
    resourceCalls = 0;
    acceptCalls = 0;
    verifyCalls = 0;

    const res2 = await client.fetch("https://api.example.com/resource");
    assert.equal(res2.status, 200);
    assert.equal(verifyCalls, 1, "should have called verifyEndpoint");
    assert.equal(acceptCalls, 1, "should have re-established after revocation");
    assert.equal(revokedId, "cid-revoked-check", "onRevoked should fire with correct contractId");
  });

  it("when checkRevocationOnUse is true and verify returns { valid: true } — token is reused, no re-establishment", async () => {
    const validToken = await signToken(
      { contractId: "cid-valid-check", templateHash: verifyEndpointReqs.templateHash, partyId: "p", resource: "/resource", iat: NOW, exp: NOW + 3600 },
      SECRET,
    );
    let acceptCalls = 0;
    let verifyCalls = 0;

    mockFetch(async (url) => {
      if (url.includes("/verify")) {
        verifyCalls++;
        return new Response(JSON.stringify({ valid: true }), { status: 200 });
      }
      if (url.includes("/accept")) {
        acceptCalls++;
        const resp: AcceptResponse = { status: "accepted", contractId: "cid-v2", token: validToken };
        return new Response(JSON.stringify(resp), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    // Establish agreement first to prime the verifyEndpointByHash map
    const client = new ContractClient({
      partyData: { name: "Test" },
      skipTemplateVerification: true,
      checkRevocationOnUse: true,
    });
    await client.establishAgreement(verifyEndpointReqs);
    acceptCalls = 0; // reset counter after initial establishment

    const res = await client.fetch("https://api.example.com/resource");
    assert.equal(res.status, 200);
    assert.equal(verifyCalls, 1, "should have called verifyEndpoint");
    assert.equal(acceptCalls, 0, "should NOT re-establish when token is still valid");
  });

  it("when checkRevocationOnUse is false (default) — verify endpoint is never called even if verifyEndpoint is in requirements", async () => {
    const validToken = await signToken(
      { contractId: "cid-no-check", templateHash: verifyEndpointReqs.templateHash, partyId: "p", resource: "/resource", iat: NOW, exp: NOW + 3600 },
      SECRET,
    );
    let verifyCalls = 0;

    mockFetch(async (url) => {
      if (url.includes("/verify")) {
        verifyCalls++;
        return new Response(JSON.stringify({ valid: false }), { status: 200 });
      }
      if (url.includes("/accept")) {
        const resp: AcceptResponse = { status: "accepted", contractId: "cid-nc2", token: validToken };
        return new Response(JSON.stringify(resp), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    // Default client — checkRevocationOnUse not set (defaults to false)
    const client = new ContractClient({
      partyData: { name: "Test" },
      skipTemplateVerification: true,
    });
    await client.establishAgreement(verifyEndpointReqs);

    await client.fetch("https://api.example.com/resource");
    assert.equal(verifyCalls, 0, "verifyEndpoint should NOT be called when checkRevocationOnUse is false");
  });
});

describe("ContractClient partyData as function", () => {
  it("resolves partyData by calling the function with the current requirements", async () => {
    const token = await freshToken();
    let capturedBody: AcceptRequest | null = null;

    mockFetch(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as AcceptRequest;
      const resp: AcceptResponse = { status: "accepted", contractId: "cid-fn", token };
      return new Response(JSON.stringify(resp), { status: 200 });
    });

    const client = new ContractClient({
      partyData: async (req) => ({ name: "Dynamic Agent", resource: req.resource }),
      skipTemplateVerification: true,
    });
    await client.establishAgreement(requirements);

    assert.ok(capturedBody !== null);
    assert.equal((capturedBody as AcceptRequest).partyData["name"], "Dynamic Agent");
    assert.equal((capturedBody as AcceptRequest).partyData["resource"], requirements.resource);
  });

  it("calls the partyData function once per round even on counter-offers", async () => {
    const token = await freshToken();
    const counter: ContractRequirements = { ...requirements };
    let callCount = 0;
    let round = 0;

    mockFetch(async () => {
      round++;
      if (round === 1) {
        const resp: AcceptResponse = { status: "counter_offer", contractId: "cid-co", token: "", counterOffer: counter };
        return new Response(JSON.stringify(resp), { status: 200 });
      }
      const resp: AcceptResponse = { status: "accepted", contractId: "cid-ok", token };
      return new Response(JSON.stringify(resp), { status: 200 });
    });

    const client = new ContractClient({
      partyData: async () => { callCount++; return { name: "Test" }; },
      skipTemplateVerification: true,
    });
    await client.establishAgreement(requirements);
    assert.equal(callCount, 2); // once per round (initial + after counter)
  });
});

describe("ContractClient cache invalidation on server rejection", () => {
  it("evicts the cached token and re-establishes when server returns 490 with a token already presented", async () => {
    const staleToken = await signToken(
      { contractId: "cid-stale", templateHash: requirements.templateHash, partyId: "p", resource: "/resource", iat: NOW, exp: NOW + 7200 },
      SECRET,
    );
    const freshTok = await freshToken();
    const reqHeader = b64encode(JSON.stringify(requirements));
    let acceptCalls = 0;
    let resourceCalls = 0;

    mockFetch(async (url, init) => {
      if (url.includes("/accept")) {
        acceptCalls++;
        const resp: AcceptResponse = { status: "accepted", contractId: "cid-new", token: freshTok };
        return new Response(JSON.stringify(resp), { status: 200 });
      }
      resourceCalls++;
      // Return 490 on first resource call (even if token was presented), then 200
      if (resourceCalls === 1) {
        return new Response(null, { status: 490, headers: { "X-490-Requirements": reqHeader } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    // Pre-populate cache with the stale token
    const sharedCache = new Map<string, string>([[requirements.templateHash, staleToken]]);
    const client = new ContractClient({ partyData: { name: "Test" }, skipTemplateVerification: true, cache: sharedCache });

    const res = await client.fetch("https://api.example.com/resource");
    assert.equal(res.status, 200);
    assert.equal(acceptCalls, 1, "should have re-established after stale token rejection");
  });

  it("calls onRevoked with the contractId of the evicted token", async () => {
    const staleToken = await signToken(
      { contractId: "cid-revoked", templateHash: requirements.templateHash, partyId: "p", resource: "/resource", iat: NOW, exp: NOW + 7200 },
      SECRET,
    );
    const freshTok = await freshToken();
    const reqHeader = b64encode(JSON.stringify(requirements));
    let revokedId: string | null = null;
    let resourceCalls = 0;

    mockFetch(async (url) => {
      if (url.includes("/accept")) {
        const resp: AcceptResponse = { status: "accepted", contractId: "cid-new2", token: freshTok };
        return new Response(JSON.stringify(resp), { status: 200 });
      }
      resourceCalls++;
      if (resourceCalls === 1) {
        return new Response(null, { status: 490, headers: { "X-490-Requirements": reqHeader } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const sharedCache = new Map<string, string>([[requirements.templateHash, staleToken]]);
    const client = new ContractClient({
      partyData: { name: "Test" },
      skipTemplateVerification: true,
      cache: sharedCache,
      onRevoked: (id) => { revokedId = id; },
    });

    await client.fetch("https://api.example.com/resource");
    assert.equal(revokedId, "cid-revoked");
  });

  it("does not call onRevoked when 490 is a fresh gate (no token was presented)", async () => {
    const freshTok = await freshToken();
    const reqHeader = b64encode(JSON.stringify(requirements));
    let revokedCalled = false;
    let resourceCalls = 0;

    mockFetch(async (url) => {
      if (url.includes("/accept")) {
        const resp: AcceptResponse = { status: "accepted", contractId: "cid-fresh2", token: freshTok };
        return new Response(JSON.stringify(resp), { status: 200 });
      }
      resourceCalls++;
      if (resourceCalls === 1) {
        return new Response(null, { status: 490, headers: { "X-490-Requirements": reqHeader } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const client = new ContractClient({
      partyData: { name: "Test" },
      skipTemplateVerification: true,
      onRevoked: () => { revokedCalled = true; },
    });

    await client.fetch("https://api.example.com/resource");
    assert.ok(!revokedCalled, "onRevoked should not fire on a fresh 490 with no prior token");
  });
});
