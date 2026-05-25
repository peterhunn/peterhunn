import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { AgentContractClient } from "../agent-client.js";
import { AnthropicClient } from "../llm.js";
import type { LLMClient } from "../llm.js";
import type { ContractRequirements, AcceptResponse } from "@x490/protocol";
import { signToken } from "@x490/protocol";

// ── Constants ──────────────────────────────────────────────────────────────────

const SECRET = "agent-client-test-secret";
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

async function freshToken(): Promise<string> {
  return signToken(
    {
      contractId: "cid-fresh",
      templateHash: requirements.templateHash,
      partyId: "test-party",
      resource: "/resource",
      iat: NOW,
      exp: NOW + 3600,
    },
    SECRET,
  );
}

function b64encode(str: string): string {
  return Buffer.from(str).toString("base64");
}

// ── Mock LLM ──────────────────────────────────────────────────────────────────

function makeMockLLM(response: object): LLMClient {
  return { complete: async () => ({ content: JSON.stringify(response), stopReason: "end_turn" }) };
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

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    return handler(input.toString(), init);
  };
}

// ── 1. fetch passes through 200 response unchanged ────────────────────────────

describe("AgentContractClient.fetch — 200 passthrough", () => {
  it("returns 200 response unchanged", async () => {
    mockFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const client = new AgentContractClient({
      partyData: { name: "Test" },
      llm: makeMockLLM({ decision: "accept", reason: "OK" }),
    });
    const res = await client.fetch("https://api.example.com/resource");
    assert.equal(res.status, 200);
  });
});

// ── 2. fetch on 490 calls Claude for review (accept) and re-establishes ───────

describe("AgentContractClient.fetch — 490 triggers Claude review then retry", () => {
  it("establishes agreement on 490 and retries successfully", async () => {
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

    const client = new AgentContractClient({
      partyData: { name: "Test" },
      skipTemplateVerification: true,
      llm: makeMockLLM({ decision: "accept", reason: "Looks good" }),
    });
    const res = await client.fetch("https://api.example.com/resource");
    assert.equal(res.status, 200);
  });
});

// ── 3. reviewRequirements throws when Claude returns reject ───────────────────

describe("AgentContractClient — Claude reject throws", () => {
  it("throws when Claude decision is reject", async () => {
    const token = await freshToken();
    mockFetch(async (url) => {
      if (url.includes("/accept")) {
        const resp: AcceptResponse = { status: "accepted", contractId: "cid-1", token };
        return new Response(JSON.stringify(resp), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const client = new AgentContractClient({
      partyData: { name: "Test" },
      skipTemplateVerification: true,
      llm: makeMockLLM({ decision: "reject", reason: "Terms are unacceptable" }),
    });
    await assert.rejects(
      () => client.establishAgreement(requirements),
      /x490 agent rejected contract/,
    );
  });
});

// ── 4. reviewRequirements calls onReview callback when provided ───────────────

describe("AgentContractClient — onReview callback", () => {
  it("calls onReview instead of auto-rejecting", async () => {
    const token = await freshToken();
    let reviewCalled = false;
    mockFetch(async (url) => {
      if (url.includes("/accept")) {
        const resp: AcceptResponse = { status: "accepted", contractId: "cid-1", token };
        return new Response(JSON.stringify(resp), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const client = new AgentContractClient({
      partyData: { name: "Test" },
      skipTemplateVerification: true,
      llm: makeMockLLM({ decision: "reject", reason: "Terms look bad" }),
      onReview: async (decision, _reqs) => {
        reviewCalled = true;
        // Caller decides not to throw — allows the flow to continue
        assert.equal(decision.decision, "reject");
      },
    });
    // Should not throw because onReview doesn't throw
    await client.establishAgreement(requirements);
    assert.ok(reviewCalled, "onReview should have been called");
  });
});

// ── 5. proposeNegotiation returns proposedTerms when Claude returns negotiate ─

describe("AgentContractClient — negotiate decision returns proposedTerms", () => {
  it("returns proposedTerms from Claude when decision is negotiate", async () => {
    const negotiableReqs: ContractRequirements = {
      ...requirements,
      negotiable: true,
      negotiableFields: [
        { field: "jurisdiction", allowedValues: ["US", "UK"], description: "Jurisdiction" },
      ],
      negotiateEndpoint: "https://api.example.com/negotiate",
    };

    const token = await freshToken();
    let hitUrl = "";

    mockFetch(async (url) => {
      hitUrl = url;
      const resp: AcceptResponse = { status: "accepted", contractId: "cid-neg", token };
      return new Response(JSON.stringify(resp), { status: 200 });
    });

    const client = new AgentContractClient({
      partyData: { name: "Test" },
      skipTemplateVerification: true,
      llm: makeMockLLM({ decision: "negotiate", reason: "Jurisdiction should be US", proposedTerms: { jurisdiction: "US" } }),
    });
    await client.establishAgreement(negotiableReqs);
    // Should have used negotiateEndpoint because proposedTerms were returned
    assert.equal(hitUrl, "https://api.example.com/negotiate");
  });
});

// ── 6. proposeNegotiation returns undefined when contract is not negotiable ───

describe("AgentContractClient — non-negotiable contract skips Claude negotiation", () => {
  it("returns undefined from proposeNegotiation when negotiable is false", async () => {
    const token = await freshToken();
    let hitUrl = "";

    mockFetch(async (url) => {
      hitUrl = url;
      const resp: AcceptResponse = { status: "accepted", contractId: "cid-acc", token };
      return new Response(JSON.stringify(resp), { status: 200 });
    });

    const client = new AgentContractClient({
      partyData: { name: "Test" },
      skipTemplateVerification: true,
      llm: makeMockLLM({ decision: "negotiate", reason: "Want to negotiate", proposedTerms: { jurisdiction: "US" } }),
    });
    // requirements.negotiable is false — should use acceptEndpoint
    await client.establishAgreement(requirements);
    assert.equal(hitUrl, "https://api.example.com/accept");
  });
});

// ── 7. Falls back to accept on invalid Claude JSON ────────────────────────────

describe("AgentContractClient — invalid Claude JSON falls back to accept", () => {
  it("defaults to accept when Claude response cannot be parsed", async () => {
    const token = await freshToken();
    mockFetch(async (url) => {
      if (url.includes("/accept")) {
        const resp: AcceptResponse = { status: "accepted", contractId: "cid-fallback", token };
        return new Response(JSON.stringify(resp), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const client = new AgentContractClient({
      partyData: { name: "Test" },
      skipTemplateVerification: true,
      llm: { complete: async () => ({ content: "not valid json {{{", stopReason: "end_turn" }) },
    });
    // Should not throw — defaults to accept
    const result = await client.establishAgreement(requirements);
    assert.ok(typeof result === "string", "should return a token");
  });
});

// ── 8. Prompt caching: system uses cache_control ephemeral ────────────────────

describe("AgentContractClient — prompt caching on system prompt", () => {
  it("passes cache_control ephemeral on the system prompt block", async () => {
    const token = await freshToken();
    let capturedSystemArg: unknown;

    mockFetch(async (url) => {
      if (url.includes("/accept")) {
        const resp: AcceptResponse = { status: "accepted", contractId: "cid-cache", token };
        return new Response(JSON.stringify(resp), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    // Verify that AnthropicClient passes cache_control ephemeral on the system prompt
    const capturingSdk = {
      beta: {
        promptCaching: {
          messages: {
            create: async (params: { system?: unknown }) => {
              capturedSystemArg = params.system;
              return {
                content: [{ type: "text", text: JSON.stringify({ decision: "accept", reason: "OK" }) }],
                stop_reason: "end_turn",
              };
            },
          },
        },
      },
    };
    const capturingLLM: LLMClient = new AnthropicClient(capturingSdk);

    const client = new AgentContractClient({
      partyData: { name: "Test" },
      skipTemplateVerification: true,
      llm: capturingLLM,
    });
    await client.establishAgreement(requirements);

    // system should be an array of blocks with cache_control
    assert.ok(Array.isArray(capturedSystemArg), "system should be an array");
    const blocks = capturedSystemArg as Array<{ type: string; text: string; cache_control?: { type: string } }>;
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.type, "text");
    assert.deepEqual(blocks[0]?.cache_control, { type: "ephemeral" });
  });
});
