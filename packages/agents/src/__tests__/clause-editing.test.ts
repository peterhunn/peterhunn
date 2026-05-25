import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentContractServer } from "../agent-server.js";
import { AgentContractClient } from "../agent-client.js";
import { extractClauses, applyClauseEdits, applyAndHash } from "../apply-clauses.js";
import type { LLMClient } from "../llm.js";
import type { ContractRequirements, AcceptRequest } from "@x490/protocol";
import { signToken } from "@x490/protocol";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = Math.floor(Date.now() / 1000);
const SECRET = "clause-test-secret";

const baseReqs: ContractRequirements = {
  scheme: "x490", version: 1,
  templateId: "com.example.nda",
  templateUrl: "https://example.com/nda.md",
  templateHash: "hash123",
  requiredPartyFields: ["name"],
  acceptEndpoint: "https://example.com/accept",
  expiresIn: 3600, resource: "/data", description: "NDA", negotiable: true,
};

const markedTemplate = [
  "# Non-Disclosure Agreement",
  "",
  "<!-- clause:liability -->",
  "Liability is limited to $100,000.",
  "<!-- /clause:liability -->",
  "",
  "<!-- clause:term -->",
  "This agreement lasts 2 years.",
  "<!-- /clause:term -->",
].join("\n");

async function freshToken(): Promise<string> {
  return signToken(
    { contractId: "cid-c", templateHash: "hash123", partyId: "agent", resource: "/data", iat: NOW, exp: NOW + 3600 },
    SECRET,
  );
}

function mockLLM(response: object): LLMClient {
  return { complete: async () => ({ content: JSON.stringify(response), stopReason: "end_turn" }) };
}

// ── extractClauses ────────────────────────────────────────────────────────────

describe("extractClauses", () => {
  it("extracts all clause blocks from a marked document", () => {
    const clauses = extractClauses(markedTemplate);
    assert.equal(clauses["liability"], "Liability is limited to $100,000.");
    assert.equal(clauses["term"], "This agreement lasts 2 years.");
  });

  it("returns empty object when no clause markers are present", () => {
    const clauses = extractClauses("No markers here.");
    assert.deepEqual(clauses, {});
  });
});

// ── applyClauseEdits ──────────────────────────────────────────────────────────

describe("applyClauseEdits", () => {
  it("replaces marked clause content with proposed text", () => {
    const result = applyClauseEdits(markedTemplate, { liability: "Liability is capped at $500,000." });
    assert.ok(result.includes("Liability is capped at $500,000."));
    assert.ok(!result.includes("Liability is limited to $100,000."));
  });

  it("leaves unmarked clauses unchanged", () => {
    const result = applyClauseEdits(markedTemplate, { liability: "New liability text." });
    assert.ok(result.includes("This agreement lasts 2 years."));
  });

  it("ignores edits for clause ids not present in document", () => {
    const result = applyClauseEdits(markedTemplate, { nonexistent: "some text" });
    assert.equal(result, markedTemplate);
  });

  it("applies multiple edits in one pass", () => {
    const result = applyClauseEdits(markedTemplate, {
      liability: "No liability.",
      term: "This agreement lasts 5 years.",
    });
    assert.ok(result.includes("No liability."));
    assert.ok(result.includes("5 years."));
  });
});

// ── applyAndHash ──────────────────────────────────────────────────────────────

describe("applyAndHash", () => {
  it("returns modified document and 64-char hex hash", async () => {
    const { document, hash } = await applyAndHash(markedTemplate, { liability: "No liability." });
    assert.ok(document.includes("No liability."));
    assert.equal(hash.length, 64);
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  it("produces different hashes for different edits", async () => {
    const { hash: h1 } = await applyAndHash(markedTemplate, { liability: "Cap at $1m." });
    const { hash: h2 } = await applyAndHash(markedTemplate, { liability: "Cap at $2m." });
    assert.notEqual(h1, h2);
  });
});

// ── Feature flag enforcement ──────────────────────────────────────────────────

describe("AgentContractServer — clauseEditing feature flag", () => {
  it("throws when clauses proposed but clauseEditing is not enabled", async () => {
    const server = new AgentContractServer({
      requirements: baseReqs,  // no clauseEditing
      issueToken: async () => freshToken(),
      llm: mockLLM({ decision: "accept", reason: "ok" }),
    });
    const req: AcceptRequest = {
      templateId: "com.example.nda", templateHash: "hash123",
      partyData: { name: "Alice" },
      negotiationTerms: { clauses: { liability: "No liability." } },
    };
    await assert.rejects(() => server.handleAccept(req), /clause editing is not enabled/);
  });

  it("throws when negotiationTerms.clauses is not an object", async () => {
    const server = new AgentContractServer({
      requirements: { ...baseReqs, clauseEditing: true },
      issueToken: async () => freshToken(),
      llm: mockLLM({ decision: "accept", reason: "ok" }),
    });
    const req: AcceptRequest = {
      templateId: "com.example.nda", templateHash: "hash123",
      partyData: { name: "Alice" },
      negotiationTerms: { clauses: "not an object" },
    };
    await assert.rejects(() => server.handleAccept(req), /must be a Record/);
  });

  it("accepts clause edits and returns agreementHash when LLM accepts", async () => {
    const server = new AgentContractServer({
      requirements: { ...baseReqs, clauseEditing: true },
      templateContent: markedTemplate,
      issueToken: async () => freshToken(),
      llm: mockLLM({ decision: "accept", reason: "ok" }),
    });
    const req: AcceptRequest = {
      templateId: "com.example.nda", templateHash: "hash123",
      partyData: { name: "Alice" },
      negotiationTerms: { clauses: { liability: "Liability capped at $500,000." } },
    };
    const res = await server.handleAccept(req);
    assert.equal(res.status, "accepted");
    assert.ok(res.agreementHash !== undefined, "agreementHash should be present");
    assert.match(res.agreementHash!, /^[0-9a-f]{64}$/);
  });

  it("accepted response has no agreementHash when no templateContent is provided", async () => {
    const server = new AgentContractServer({
      requirements: { ...baseReqs, clauseEditing: true },
      // no templateContent
      issueToken: async () => freshToken(),
      llm: mockLLM({ decision: "accept", reason: "ok" }),
    });
    const req: AcceptRequest = {
      templateId: "com.example.nda", templateHash: "hash123",
      partyData: { name: "Alice" },
      negotiationTerms: { clauses: { liability: "No liability." } },
    };
    const res = await server.handleAccept(req);
    assert.equal(res.status, "accepted");
    assert.equal(res.agreementHash, undefined);
  });
});

// ── LLM sees clause comparison ────────────────────────────────────────────────

describe("AgentContractServer — clause comparison in LLM context", () => {
  it("passes current vs proposed clause text to LLM", async () => {
    let capturedContent = "";
    const server = new AgentContractServer({
      requirements: { ...baseReqs, clauseEditing: true },
      templateContent: markedTemplate,
      issueToken: async () => freshToken(),
      llm: {
        complete: async (_sys, msgs) => {
          capturedContent = msgs[0]?.content ?? "";
          return { content: JSON.stringify({ decision: "accept", reason: "ok" }), stopReason: "end_turn" };
        },
      },
    });
    const req: AcceptRequest = {
      templateId: "com.example.nda", templateHash: "hash123",
      partyData: { name: "Alice" },
      negotiationTerms: { clauses: { liability: "Liability capped at $500,000." } },
    };
    await server.handleAccept(req);
    assert.ok(capturedContent.includes("PROPOSED CLAUSE EDITS"), "LLM should see clause comparison section");
    assert.ok(capturedContent.includes("CURRENT:"), "LLM should see current clause text");
    assert.ok(capturedContent.includes("PROPOSED:"), "LLM should see proposed clause text");
    assert.ok(capturedContent.includes("$500,000"), "LLM should see proposed text");
  });
});

// ── Client prompt ─────────────────────────────────────────────────────────────

describe("AgentContractClient — clause editing in system prompt", () => {
  it("includes clause editing note when clauseEditing is true", async () => {
    let capturedSystem = "";
    const reqs: ContractRequirements = { ...baseReqs, clauseEditing: true };
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
        llm: {
          complete: async (sys) => {
            capturedSystem = sys;
            return { content: JSON.stringify({ decision: "accept", reason: "ok" }), stopReason: "end_turn" };
          },
        },
      });
      await client.establishAgreement(reqs);
    } finally {
      globalThis.fetch = origFetch;
    }
    assert.ok(capturedSystem.includes("clauses"), "system prompt should mention clause editing");
    assert.ok(capturedSystem.includes("clause-id"), "system prompt should explain clause id format");
  });

  it("does not include clause editing note when clauseEditing is absent", async () => {
    let capturedSystem = "";
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
        llm: {
          complete: async (sys) => {
            capturedSystem = sys;
            return { content: JSON.stringify({ decision: "accept", reason: "ok" }), stopReason: "end_turn" };
          },
        },
      });
      await client.establishAgreement(baseReqs);
    } finally {
      globalThis.fetch = origFetch;
    }
    assert.ok(!capturedSystem.includes("clause-id"), "system prompt should not mention clause editing");
  });
});
