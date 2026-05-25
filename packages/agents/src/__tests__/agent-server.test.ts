import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentContractServer } from "../agent-server.js";
import { AgentContractClient } from "../agent-client.js";
import type { LLMClient } from "../llm.js";
import type { ContractRequirements, AcceptRequest, AcceptResponse } from "@x490/protocol";
import { signToken } from "@x490/protocol";

// ── Shared fixtures ────────────────────────────────────────────────────────────

const SECRET = "a2a-test-secret";
const NOW = Math.floor(Date.now() / 1000);

const baseRequirements: ContractRequirements = {
  scheme: "x490",
  version: 1,
  templateId: "org.accordproject.test",
  templateUrl: "https://server.example.com/template",
  templateHash: "testhash",
  requiredPartyFields: ["name"],
  acceptEndpoint: "https://server.example.com/accept",
  expiresIn: 3600,
  resource: "/api/data",
  description: "Test contract",
  negotiable: true,
  negotiableFields: [
    { field: "expiresIn", description: "Token lifetime in seconds", allowedValues: ["3600", "7200"] },
  ],
};

async function freshToken(contractId = "cid-1"): Promise<string> {
  return signToken(
    { contractId, templateHash: "testhash", partyId: "agent", resource: "/api/data", iat: NOW, exp: NOW + 3600 },
    SECRET,
  );
}

function makeMockLLM(response: object): LLMClient {
  return { complete: async () => ({ content: JSON.stringify(response), stopReason: "end_turn" }) };
}

function makeServer(claudeResponse: object, overrides: Partial<ContractRequirements> = {}) {
  return new AgentContractServer({
    requirements: { ...baseRequirements, ...overrides },
    issueToken: async (contractId, _partyData) => freshToken(contractId),
    llm: makeMockLLM(claudeResponse),
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("AgentContractServer", () => {
  it("no negotiationTerms → issues token without calling Claude", async () => {
    let claudeCalled = false;
    const server = new AgentContractServer({
      requirements: baseRequirements,
      issueToken: async (id) => freshToken(id),
      llm: {
        complete: async () => {
          claudeCalled = true;
          return { content: '{"decision":"accept","reason":"ok"}', stopReason: "end_turn" };
        },
      },
    });

    const req: AcceptRequest = { templateId: "org.accordproject.test", templateHash: "testhash", partyData: { name: "Alice" } };
    const res = await server.handleAccept(req);

    assert.equal(res.status, "accepted");
    assert.ok(res.token.length > 0);
    assert.equal(claudeCalled, false);
  });

  it("Claude accepts proposed terms → issues token", async () => {
    const server = makeServer({ decision: "accept", reason: "Terms are fair" });
    const req: AcceptRequest = {
      templateId: "org.accordproject.test",
      templateHash: "testhash",
      partyData: { name: "Alice" },
      negotiationTerms: { expiresIn: 7200 },
    };
    const res = await server.handleAccept(req);
    assert.equal(res.status, "accepted");
    assert.ok(res.token.length > 0);
  });

  it("Claude counter-proposes → returns counter_offer", async () => {
    const server = makeServer({
      decision: "counter_offer",
      reason: "Can only offer 3600s",
      counterOffer: { expiresIn: 3600 },
    });
    const req: AcceptRequest = {
      templateId: "org.accordproject.test",
      templateHash: "testhash",
      partyData: { name: "Alice" },
      negotiationTerms: { expiresIn: 86400 },
    };
    const res = await server.handleAccept(req);
    assert.equal(res.status, "counter_offer");
    assert.ok(res.counterOffer !== undefined);
    assert.equal((res.counterOffer as ContractRequirements).expiresIn, 3600);
  });

  it("Claude rejects → throws", async () => {
    const server = makeServer({ decision: "reject", reason: "Terms not acceptable" });
    const req: AcceptRequest = {
      templateId: "org.accordproject.test",
      templateHash: "testhash",
      partyData: { name: "Alice" },
      negotiationTerms: { expiresIn: 999999 },
    };
    await assert.rejects(
      () => server.handleAccept(req),
      /rejected negotiation/,
    );
  });

  it("onReview callback is called with Claude's decision", async () => {
    const calls: object[] = [];
    const server = new AgentContractServer({
      requirements: baseRequirements,
      issueToken: async (id) => freshToken(id),
      onReview: async (decision) => { calls.push(decision); },
      llm: makeMockLLM({ decision: "accept", reason: "ok" }),
    });
    const req: AcceptRequest = {
      templateId: "org.accordproject.test",
      templateHash: "testhash",
      partyData: { name: "Alice" },
      negotiationTerms: { expiresIn: 7200 },
    };
    await server.handleAccept(req);
    assert.equal(calls.length, 1);
  });

  it("invalid JSON from Claude defaults to accept", async () => {
    const server = new AgentContractServer({
      requirements: baseRequirements,
      issueToken: async (id) => freshToken(id),
      llm: { complete: async () => ({ content: "not json", stopReason: "end_turn" }) },
    });
    const req: AcceptRequest = {
      templateId: "org.accordproject.test",
      templateHash: "testhash",
      partyData: { name: "Alice" },
      negotiationTerms: { expiresIn: 7200 },
    };
    const res = await server.handleAccept(req);
    assert.equal(res.status, "accepted");
  });
});

// ── Full A2A negotiation simulation ───────────────────────────────────────────

describe("A2A negotiation loop", () => {
  it("client proposes → server counter-proposes → client accepts counter-offer", async () => {
    // Server: counter-proposes 3600 when client asks for 86400, then accepts
    let serverCallCount = 0;
    const serverResponses = [
      { decision: "counter_offer", reason: "Can only offer 3600s", counterOffer: { expiresIn: 3600 } },
      { decision: "accept", reason: "Terms accepted" },
    ];
    const server = new AgentContractServer({
      requirements: baseRequirements,
      issueToken: async (id) => freshToken(id),
      llm: { complete: async () => ({ content: JSON.stringify(serverResponses[serverCallCount++]), stopReason: "end_turn" }) },
    });

    // Client: reviewRequirements → accept; proposeNegotiation round 0 → negotiate 86400;
    //         proposeNegotiation round 1 (counter-offer accepted) → accept (no terms)
    let clientCallCount = 0;
    const clientResponses = [
      { decision: "accept", reason: "Terms look reasonable" },
      { decision: "negotiate", reason: "Want longer expiry", proposedTerms: { expiresIn: 86400 } },
      { decision: "accept", reason: "Counter-offer is acceptable" },
    ];

    // Wire client → server via an in-memory fetch mock
    const token = await freshToken("cid-a2a");
    const b64Req = Buffer.from(JSON.stringify(baseRequirements)).toString("base64url");

    let fetchCallCount = 0;
    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = input.toString();
      fetchCallCount++;

      // First call hits a 490-gated resource
      if (fetchCallCount === 1) {
        return new Response(JSON.stringify({ error: "contract required" }), {
          status: 490,
          headers: { "X-490-Requirements": b64Req },
        });
      }

      // Subsequent POSTs to accept endpoint are handled by the server
      if (url.includes("/accept")) {
        const body = JSON.parse((init?.body as string) ?? "{}") as AcceptRequest;
        const result = await server.handleAccept(body);
        return new Response(JSON.stringify(result), { status: 200 });
      }

      // Template fetch for hash verification (skip in test)
      if (url.includes("/template")) {
        return new Response("template content", { status: 200 });
      }

      // Final retry with token → 200
      return new Response(JSON.stringify({ data: "success" }), { status: 200 });
    };

    const client = new AgentContractClient({
      partyData: { name: "ClientAgent" },
      skipTemplateVerification: true,
      maxNegotiationRounds: 3,
      llm: { complete: async () => ({ content: JSON.stringify(clientResponses[Math.min(clientCallCount++, clientResponses.length - 1)]), stopReason: "end_turn" }) },
    });

    // Patch global fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as typeof fetch;
    try {
      const response = await client.fetch("https://server.example.com/api/data");
      assert.equal(response.status, 200);
      const body = await response.json() as { data: string };
      assert.equal(body.data, "success");
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Server was called at least once with negotiation terms
    assert.ok(serverCallCount >= 1, "server Claude should have been consulted");
  });
});
