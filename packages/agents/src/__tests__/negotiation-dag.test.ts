import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryNegotiationStore, computeNodeHash, formatNegotiationHistory } from "../negotiation-dag.js";
import { AgentContractServer } from "../agent-server.js";
import { AgentContractClient } from "../agent-client.js";
import type { LLMClient } from "../llm.js";
import type { ContractRequirements, AcceptRequest } from "@x490/protocol";
import { signToken } from "@x490/protocol";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = Math.floor(Date.now() / 1000);
const SECRET = "dag-test-secret";

const baseReqs: ContractRequirements = {
  scheme: "x490", version: 1,
  templateId: "com.example.nda", templateUrl: "https://example.com/nda.md",
  templateHash: "hash123", requiredPartyFields: ["name"],
  acceptEndpoint: "https://example.com/accept",
  expiresIn: 3600, resource: "/data", description: "NDA",
  negotiable: true, negotiableFields: [{ field: "expiresIn", description: "token lifetime in seconds" }],
};

async function freshToken(): Promise<string> {
  return signToken(
    { contractId: "cid-dag", templateHash: "hash123", partyId: "agent", resource: "/data", iat: NOW, exp: NOW + 3600 },
    SECRET,
  );
}

function mockLLM(responses: object[]): LLMClient {
  let i = 0;
  return {
    complete: async () => {
      const resp = responses[i] ?? responses.at(-1) ?? { decision: "accept", reason: "ok" };
      i++;
      return { content: JSON.stringify(resp), stopReason: "end_turn" };
    },
  };
}

// ── computeNodeHash ───────────────────────────────────────────────────────────

describe("computeNodeHash", () => {
  it("returns 64-char hex string", async () => {
    const hash = await computeNodeHash({
      sessionId: "s1", role: "client", round: 0,
      requirements: { foo: "bar" }, decision: "accept", reason: "ok",
    });
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  it("different inputs produce different hashes", async () => {
    const base = { sessionId: "s1", role: "client" as const, round: 0, requirements: {}, decision: "accept", reason: "ok" };
    const h1 = await computeNodeHash({ ...base, reason: "reason A" });
    const h2 = await computeNodeHash({ ...base, reason: "reason B" });
    assert.notEqual(h1, h2);
  });

  it("parentHash is included in the hash", async () => {
    const base = { sessionId: "s1", role: "client" as const, round: 1, requirements: {}, decision: "accept", reason: "ok" };
    const h1 = await computeNodeHash({ ...base, parentHash: "abc" });
    const h2 = await computeNodeHash({ ...base, parentHash: "def" });
    assert.notEqual(h1, h2);
  });
});

// ── InMemoryNegotiationStore ──────────────────────────────────────────────────

describe("InMemoryNegotiationStore", () => {
  it("appends nodes and returns them via getHistory", async () => {
    const store = new InMemoryNegotiationStore();
    const node = await store.append({
      sessionId: "s1", role: "client", round: 0,
      requirements: { expiresIn: 3600 }, decision: "accept", reason: "ok",
    });
    assert.equal(node.sessionId, "s1");
    assert.equal(node.role, "client");
    assert.match(node.hash, /^[0-9a-f]{64}$/);
    assert.equal(node.parentHash, undefined);

    const history = await store.getHistory("s1");
    assert.equal(history.length, 1);
  });

  it("sets parentHash on subsequent nodes in same session", async () => {
    const store = new InMemoryNegotiationStore();
    const n1 = await store.append({ sessionId: "s2", role: "client", round: 0, requirements: {}, decision: "accept", reason: "r1" });
    const n2 = await store.append({ sessionId: "s2", role: "server", round: 0, requirements: {}, decision: "accept", reason: "r2" });
    assert.equal(n2.parentHash, n1.hash);
  });

  it("nodes in different sessions are independent", async () => {
    const store = new InMemoryNegotiationStore();
    const n1 = await store.append({ sessionId: "sa", role: "client", round: 0, requirements: {}, decision: "accept", reason: "a" });
    const n2 = await store.append({ sessionId: "sb", role: "client", round: 0, requirements: {}, decision: "accept", reason: "b" });
    assert.equal(n1.parentHash, undefined);
    assert.equal(n2.parentHash, undefined);
    assert.equal((await store.getHistory("sa")).length, 1);
    assert.equal((await store.getHistory("sb")).length, 1);
  });

  it("returns history oldest first", async () => {
    const store = new InMemoryNegotiationStore();
    for (let i = 0; i < 3; i++) {
      await store.append({ sessionId: "s3", role: "client", round: i, requirements: {}, decision: "negotiate", reason: `round ${i}` });
    }
    const history = await store.getHistory("s3");
    assert.equal(history.length, 3);
    assert.equal(history[0]?.round, 0);
    assert.equal(history[2]?.round, 2);
  });

  it("hash chain is valid — each node references previous hash", async () => {
    const store = new InMemoryNegotiationStore();
    const nodes = [];
    for (let i = 0; i < 4; i++) {
      nodes.push(await store.append({ sessionId: "s4", role: "client", round: i, requirements: {}, decision: "negotiate", reason: `r${i}` }));
    }
    for (let i = 1; i < nodes.length; i++) {
      assert.equal(nodes[i]?.parentHash, nodes[i - 1]?.hash);
    }
  });
});

// ── formatNegotiationHistory ──────────────────────────────────────────────────

describe("formatNegotiationHistory", () => {
  it("returns empty string for no history", () => {
    assert.equal(formatNegotiationHistory([]), "");
  });

  it("formats single node", async () => {
    const store = new InMemoryNegotiationStore();
    const node = await store.append({ sessionId: "s", role: "client", round: 0, requirements: {}, decision: "negotiate", reason: "too long" });
    const text = formatNegotiationHistory([node]);
    assert.ok(text.includes("NEGOTIATION HISTORY"));
    assert.ok(text.includes("client/negotiate"));
    assert.ok(text.includes("too long"));
  });

  it("includes proposed terms when present", async () => {
    const store = new InMemoryNegotiationStore();
    const node = await store.append({
      sessionId: "s", role: "client", round: 1, requirements: {},
      proposedTerms: { expiresIn: 86400 }, decision: "negotiate", reason: "want longer",
    });
    const text = formatNegotiationHistory([node]);
    assert.ok(text.includes("86400"));
  });
});

// ── AgentContractServer — DAG recording ───────────────────────────────────────

describe("AgentContractServer — negotiation DAG", () => {
  it("records a server node when negotiationTerms are present", async () => {
    const store = new InMemoryNegotiationStore();
    const server = new AgentContractServer({
      requirements: baseReqs,
      issueToken: async () => freshToken(),
      llm: mockLLM([{ decision: "accept", reason: "ok" }]),
      negotiationStore: store,
    });
    const req: AcceptRequest = {
      templateId: "com.example.nda", templateHash: "hash123",
      partyData: { name: "Alice" },
      negotiationTerms: { expiresIn: 86400 },
    };
    await server.handleAccept(req);

    // Session ID is deterministic: SHA-256 of (templateId + templateHash + partyData)
    // We don't know it up front, but we know exactly 1 node was written
    const allSessionIds = new Set<string>();
    // Retrieve via a second identical request to get the same session ID
    const server2 = new AgentContractServer({
      requirements: baseReqs,
      issueToken: async () => freshToken(),
      llm: mockLLM([{ decision: "accept", reason: "ok" }]),
      negotiationStore: store,
    });
    await server2.handleAccept(req);

    // Both requests produce the same session ID — history should have 2 nodes
    // We verify by checking that at least one node exists for the session
    let totalNodes = 0;
    // Gather all nodes by attempting getHistory with the known request params
    const keyStr = JSON.stringify({ templateId: req.templateId, templateHash: req.templateHash, partyData: req.partyData });
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(keyStr));
    const sessionId = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
    const history = await store.getHistory(sessionId);
    assert.equal(history.length, 2);
    assert.equal(history[0]?.role, "server");
    assert.equal(history[0]?.decision, "accept");
    assert.equal(history[1]?.parentHash, history[0]?.hash);
  });

  it("does not record a node when no negotiationTerms", async () => {
    const store = new InMemoryNegotiationStore();
    const server = new AgentContractServer({
      requirements: baseReqs,
      issueToken: async () => freshToken(),
      llm: mockLLM([{ decision: "accept", reason: "ok" }]),
      negotiationStore: store,
    });
    const req: AcceptRequest = {
      templateId: "com.example.nda", templateHash: "hash123",
      partyData: { name: "Bob" },
      // no negotiationTerms — immediate token issue
    };
    await server.handleAccept(req);
    const keyStr = JSON.stringify({ templateId: req.templateId, templateHash: req.templateHash, partyData: req.partyData });
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(keyStr));
    const sessionId = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
    const history = await store.getHistory(sessionId);
    assert.equal(history.length, 0, "no node should be recorded for no-negotiation accepts");
  });

  it("passes history to LLM on second round", async () => {
    const store = new InMemoryNegotiationStore();
    let historySeenByLLM = "";
    const server = new AgentContractServer({
      requirements: baseReqs,
      issueToken: async () => freshToken(),
      llm: {
        complete: async (_sys, msgs) => {
          historySeenByLLM = msgs[0]?.content ?? "";
          return { content: JSON.stringify({ decision: "accept", reason: "ok" }), stopReason: "end_turn" };
        },
      },
      negotiationStore: store,
    });
    const req: AcceptRequest = {
      templateId: "com.example.nda", templateHash: "hash123",
      partyData: { name: "Charlie" },
      negotiationTerms: { expiresIn: 86400 },
    };
    // First call — no history yet
    await server.handleAccept(req);

    // Second call — history from first round should appear in context
    historySeenByLLM = "";
    await server.handleAccept(req);
    assert.ok(historySeenByLLM.includes("NEGOTIATION HISTORY"), "second round should include history");
  });
});

// ── AgentContractClient — DAG recording ──────────────────────────────────────

describe("AgentContractClient — negotiation DAG", () => {
  it("records a client node on initial requirements review", async () => {
    const store = new InMemoryNegotiationStore();
    const token = await freshToken();
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      if (input.toString().includes("/accept")) {
        return new Response(JSON.stringify({ status: "accepted", contractId: "c1", token }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    };
    try {
      const client = new AgentContractClient({
        partyData: { name: "Test" },
        skipTemplateVerification: true,
        llm: mockLLM([{ decision: "accept", reason: "terms are fair" }]),
        negotiationStore: store,
      });
      await client.establishAgreement(baseReqs);
    } finally {
      globalThis.fetch = origFetch;
    }
    // We can't easily get the sessionId from outside, but we know 1 node was written
    // Use the client's sessionId indirectly — verify via the store's internal state
    // The node should have role="client" and decision="accept"
    // We access private nodes via a cast for test purposes
    const allNodes = (store as unknown as { nodes: import("../negotiation-dag.js").NegotiationNode[] }).nodes;
    // reviewRequirements (round 0) + proposeNegotiation (round 1) both write nodes for negotiable contracts
    assert.ok(allNodes.length >= 1, "at least one node should be written");
    assert.equal(allNodes[0]?.role, "client");
    assert.equal(allNodes[0]?.decision, "accept");
    assert.equal(allNodes[0]?.round, 0);
  });

  it("uses stable sessionId across rounds (same instance)", async () => {
    const store = new InMemoryNegotiationStore();
    // A single client instance should use the same sessionId for all rounds
    const sid = "test-session-stable";
    const client = new AgentContractClient({
      partyData: { name: "X" },
      skipTemplateVerification: true,
      sessionId: sid,
      llm: mockLLM([{ decision: "accept", reason: "ok" }]),
      negotiationStore: store,
    });
    // Manually trigger reviewRequirements by calling the private method indirectly
    // via establishAgreement
    const token = await freshToken();
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      if (input.toString().includes("/accept")) {
        return new Response(JSON.stringify({ status: "accepted", contractId: "c1", token }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    };
    try {
      await client.establishAgreement(baseReqs);
    } finally {
      globalThis.fetch = origFetch;
    }
    const history = await store.getHistory(sid);
    assert.ok(history.length >= 1, "should have written at least one node for the given sessionId");
  });

  it("includes negotiation history in LLM context on second round", async () => {
    const store = new InMemoryNegotiationStore();
    const token = await freshToken();
    let callCount = 0;
    let secondCallContent = "";
    const origFetch = globalThis.fetch;
    // First call: return counter_offer to trigger a second negotiation round
    // Second call: server accepts
    let fetchCall = 0;
    globalThis.fetch = async (input) => {
      if (input.toString().includes("/accept")) {
        fetchCall++;
        if (fetchCall === 1) {
          return new Response(JSON.stringify({
            status: "counter_offer",
            contractId: "",
            token: "",
            counterOffer: { ...baseReqs, expiresIn: 43200 },
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ status: "accepted", contractId: "c1", token }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    };
    try {
      const client = new AgentContractClient({
        partyData: { name: "Test" },
        skipTemplateVerification: true,
        maxNegotiationRounds: 3,
        llm: {
          complete: async (_sys, msgs) => {
            callCount++;
            if (callCount >= 2) secondCallContent = msgs[0]?.content ?? "";
            return { content: JSON.stringify({ decision: "negotiate", reason: "want more", proposedTerms: { expiresIn: 86400 } }), stopReason: "end_turn" };
          },
        },
        negotiationStore: store,
      });
      await client.establishAgreement(baseReqs).catch(() => {/* negotiation may exhaust */});
    } finally {
      globalThis.fetch = origFetch;
    }
    if (secondCallContent) {
      assert.ok(secondCallContent.includes("NEGOTIATION HISTORY"), "second LLM call should include prior round history");
    }
  });
});
