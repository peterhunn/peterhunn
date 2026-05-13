import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ContractClient } from "../client.js";
import { signToken } from "../token.js";
import { b64encode } from "../codec.js";
import type { ContractRequirements, AcceptResponse, X402Response } from "../types.js";

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
