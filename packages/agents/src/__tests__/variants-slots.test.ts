import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { AgentContractServer } from "../agent-server.js";
import { AgentContractClient } from "../agent-client.js";
import { renderTemplate } from "../render-template.js";
import type { LLMClient, Message, CompletionResult } from "../llm.js";
import type { ContractRequirements, AcceptRequest } from "@x490/protocol";
import { signToken } from "@x490/protocol";

// ── Shared fixtures ────────────────────────────────────────────────────────────

const SECRET = "variants-slots-test-secret";
const NOW = Math.floor(Date.now() / 1000);

async function freshToken(contractId = "cid-vs-1"): Promise<string> {
  return signToken(
    {
      contractId,
      templateHash: "basehash",
      partyId: "agent",
      resource: "/api/data",
      iat: NOW,
      exp: NOW + 3600,
    },
    SECRET,
  );
}

function makeMockLLM(response: object): LLMClient {
  return {
    complete: async () => ({ content: JSON.stringify(response), stopReason: "end_turn" }),
  };
}

/** Capture LLM: records what was passed in, returns a canned response. */
function makeCapturingLLM(
  response: object,
): { llm: LLMClient; calls: Array<{ systemPrompt: string; messages: Message[] }> } {
  const calls: Array<{ systemPrompt: string; messages: Message[] }> = [];
  const llm: LLMClient = {
    complete: async (systemPrompt: string, messages: Message[]): Promise<CompletionResult> => {
      calls.push({ systemPrompt, messages });
      return { content: JSON.stringify(response), stopReason: "end_turn" };
    },
  };
  return { llm, calls };
}

const variantsRequirements: ContractRequirements = {
  scheme: "x490",
  version: 1,
  templateId: "org.accordproject.variants-test",
  templateUrl: "https://server.example.com/template",
  templateHash: "basehash",
  requiredPartyFields: ["name"],
  acceptEndpoint: "https://server.example.com/accept",
  expiresIn: 3600,
  resource: "/api/data",
  description: "Test contract with variants",
  negotiable: true,
  variants: {
    standard: {
      templateUrl: "https://server.example.com/template/standard",
      templateHash: "standardhash",
      description: "Standard terms",
    },
    premium: {
      templateUrl: "https://server.example.com/template/premium",
      templateHash: "premiumhash",
      description: "Premium terms",
    },
  },
};

const slotsRequirements: ContractRequirements = {
  scheme: "x490",
  version: 1,
  templateId: "org.accordproject.slots-test",
  templateUrl: "https://server.example.com/template",
  templateHash: "basehash",
  requiredPartyFields: ["name"],
  acceptEndpoint: "https://server.example.com/accept",
  expiresIn: 3600,
  resource: "/api/data",
  description: "Test contract with template variables",
  negotiable: true,
  templateVariables: {
    jurisdiction: {
      description: "Governing jurisdiction",
      defaultValue: "US",
      allowedValues: ["US", "UK", "EU"],
    },
    tier: {
      description: "Service tier",
      allowedValues: ["basic", "pro", "enterprise"],
    },
  },
};

function makeServer(
  claudeResponse: object,
  overrides: Partial<ContractRequirements> = {},
  extraOpts: { templateContent?: string } = {},
) {
  return new AgentContractServer({
    requirements: { ...variantsRequirements, ...overrides },
    issueToken: async (contractId) => freshToken(contractId),
    llm: makeMockLLM(claudeResponse),
    ...extraOpts,
  });
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

// ── 1. Variant validation — server rejects unknown variant key ─────────────────

describe("AgentContractServer — variant validation", () => {
  it("rejects an unknown variant key", async () => {
    const server = makeServer({ decision: "accept", reason: "ok" });
    const req: AcceptRequest = {
      templateId: "org.accordproject.variants-test",
      templateHash: "basehash",
      partyData: { name: "Alice" },
      negotiationTerms: { variant: "nonexistent" },
    };
    await assert.rejects(
      () => server.handleAccept(req),
      /unknown variant "nonexistent"/,
    );
  });

  it("error message lists available variants", async () => {
    const server = makeServer({ decision: "accept", reason: "ok" });
    const req: AcceptRequest = {
      templateId: "org.accordproject.variants-test",
      templateHash: "basehash",
      partyData: { name: "Alice" },
      negotiationTerms: { variant: "bogus" },
    };
    try {
      await server.handleAccept(req);
      assert.fail("should have thrown");
    } catch (err) {
      assert.match(String(err), /standard/);
      assert.match(String(err), /premium/);
    }
  });
});

// ── 2. Variable validation — server rejects disallowed variable value ──────────

describe("AgentContractServer — template variable validation", () => {
  it("rejects a disallowed value for a template variable", async () => {
    const server = new AgentContractServer({
      requirements: slotsRequirements,
      issueToken: async (contractId) => freshToken(contractId),
      llm: makeMockLLM({ decision: "accept", reason: "ok" }),
    });
    const req: AcceptRequest = {
      templateId: "org.accordproject.slots-test",
      templateHash: "basehash",
      partyData: { name: "Alice" },
      negotiationTerms: { jurisdiction: "AU" }, // not in allowedValues
    };
    await assert.rejects(
      () => server.handleAccept(req),
      /"AU" is not an allowed value for variable "jurisdiction"/,
    );
  });

  it("error message lists allowed values", async () => {
    const server = new AgentContractServer({
      requirements: slotsRequirements,
      issueToken: async (contractId) => freshToken(contractId),
      llm: makeMockLLM({ decision: "accept", reason: "ok" }),
    });
    const req: AcceptRequest = {
      templateId: "org.accordproject.slots-test",
      templateHash: "basehash",
      partyData: { name: "Alice" },
      negotiationTerms: { tier: "gold" }, // not in allowedValues
    };
    try {
      await server.handleAccept(req);
      assert.fail("should have thrown");
    } catch (err) {
      assert.match(String(err), /basic/);
      assert.match(String(err), /pro/);
      assert.match(String(err), /enterprise/);
    }
  });

  it("accepts a value that is in allowedValues", async () => {
    const server = new AgentContractServer({
      requirements: slotsRequirements,
      issueToken: async (contractId) => freshToken(contractId),
      llm: makeMockLLM({ decision: "accept", reason: "ok" }),
    });
    const req: AcceptRequest = {
      templateId: "org.accordproject.slots-test",
      templateHash: "basehash",
      partyData: { name: "Alice" },
      negotiationTerms: { jurisdiction: "UK" },
    };
    const res = await server.handleAccept(req);
    assert.equal(res.status, "accepted");
  });
});

// ── 3. Variant accepted — server accepts valid variant selection ───────────────

describe("AgentContractServer — valid variant selection", () => {
  it("accepts a request with a known variant key", async () => {
    const server = makeServer({ decision: "accept", reason: "Standard variant is fine" });
    const req: AcceptRequest = {
      templateId: "org.accordproject.variants-test",
      templateHash: "basehash",
      partyData: { name: "Alice" },
      negotiationTerms: { variant: "standard" },
    };
    const res = await server.handleAccept(req);
    assert.equal(res.status, "accepted");
    assert.ok(res.token.length > 0);
  });

  it("accepts premium variant", async () => {
    const server = makeServer({ decision: "accept", reason: "Premium variant approved" });
    const req: AcceptRequest = {
      templateId: "org.accordproject.variants-test",
      templateHash: "basehash",
      partyData: { name: "Alice" },
      negotiationTerms: { variant: "premium" },
    };
    const res = await server.handleAccept(req);
    assert.equal(res.status, "accepted");
  });
});

// ── 4. Slot rendering — renderTemplate replaces {{key}}, leaves unknown slots ──

describe("renderTemplate", () => {
  it("replaces known slots with provided values", () => {
    const template = "This agreement is governed by {{jurisdiction}} law.";
    const result = renderTemplate(template, { jurisdiction: "California" });
    assert.equal(result, "This agreement is governed by California law.");
  });

  it("leaves unknown slots as-is", () => {
    const template = "Hello {{name}}, your tier is {{tier}}.";
    const result = renderTemplate(template, { name: "Alice" }); // no tier
    assert.equal(result, "Hello Alice, your tier is {{tier}}.");
  });

  it("replaces multiple occurrences of the same slot", () => {
    const template = "{{party}} agrees that {{party}} will comply.";
    const result = renderTemplate(template, { party: "Acme Corp" });
    assert.equal(result, "Acme Corp agrees that Acme Corp will comply.");
  });

  it("handles empty variables map — returns template unchanged", () => {
    const template = "Clause 1: {{a}}, Clause 2: {{b}}";
    const result = renderTemplate(template, {});
    assert.equal(result, "Clause 1: {{a}}, Clause 2: {{b}}");
  });

  it("handles template with no slots", () => {
    const template = "No slots here.";
    const result = renderTemplate(template, { unused: "value" });
    assert.equal(result, "No slots here.");
  });
});

// ── 5. Client prompt includes variants ────────────────────────────────────────

describe("AgentContractClient — claudeReview includes variants info", () => {
  it("passes variant info in the user message when requirements.variants is set", async () => {
    const { llm, calls } = makeCapturingLLM({ decision: "accept", reason: "ok" });

    const token = await freshToken("cid-client-vars");
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/accept")) {
        return new Response(
          JSON.stringify({ status: "accepted", contractId: "cid-client-vars", token }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const client = new AgentContractClient({
      partyData: { name: "Test" },
      skipTemplateVerification: true,
      llm,
    });

    await client.establishAgreement(variantsRequirements);

    assert.ok(calls.length > 0, "LLM should have been called");
    const userContent = calls[0]!.messages[0]!.content;
    assert.ok(userContent.includes("AVAILABLE VARIANTS"), "should include AVAILABLE VARIANTS section");
    assert.ok(userContent.includes('"standard"'), "should mention standard variant");
    assert.ok(userContent.includes('"premium"'), "should mention premium variant");
    assert.ok(userContent.includes("Standard terms"), "should include variant description");
    assert.ok(userContent.includes("Premium terms"), "should include variant description");
  });
});

// ── 6. Client prompt includes template variables ───────────────────────────────

describe("AgentContractClient — claudeReview includes templateVariables info", () => {
  it("passes template variable info in the user message when templateVariables is set", async () => {
    const { llm, calls } = makeCapturingLLM({ decision: "accept", reason: "ok" });

    const token = await freshToken("cid-client-slots");
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/accept")) {
        return new Response(
          JSON.stringify({ status: "accepted", contractId: "cid-client-slots", token }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const client = new AgentContractClient({
      partyData: { name: "Test" },
      skipTemplateVerification: true,
      llm,
    });

    await client.establishAgreement(slotsRequirements);

    assert.ok(calls.length > 0, "LLM should have been called");
    const userContent = calls[0]!.messages[0]!.content;
    assert.ok(
      userContent.includes("TEMPLATE VARIABLES"),
      "should include TEMPLATE VARIABLES section",
    );
    assert.ok(userContent.includes("jurisdiction"), "should mention jurisdiction slot");
    assert.ok(userContent.includes("tier"), "should mention tier slot");
    assert.ok(userContent.includes("US"), "should include default value for jurisdiction");
    assert.ok(userContent.includes("basic"), "should include allowed values for tier");
    assert.ok(userContent.includes("enterprise"), "should include allowed values for tier");
  });
});

// ── 7. Server renders slots for LLM ───────────────────────────────────────────

describe("AgentContractServer — renders template slots for LLM review", () => {
  it("renders {{slotName}} placeholders in templateContent before passing to LLM", async () => {
    const { llm, calls } = makeCapturingLLM({ decision: "accept", reason: "ok" });

    const server = new AgentContractServer({
      requirements: slotsRequirements,
      templateContent: "This agreement applies in {{jurisdiction}}. Tier: {{tier}}.",
      issueToken: async (contractId) => freshToken(contractId),
      llm,
    });

    const req: AcceptRequest = {
      templateId: "org.accordproject.slots-test",
      templateHash: "basehash",
      partyData: { name: "Alice" },
      negotiationTerms: { jurisdiction: "UK", tier: "pro" },
    };

    await server.handleAccept(req);

    assert.ok(calls.length > 0, "LLM should have been called");
    const userContent = calls[0]!.messages[0]!.content;
    assert.ok(
      userContent.includes("This agreement applies in UK."),
      "rendered jurisdiction should appear in LLM prompt",
    );
    assert.ok(
      userContent.includes("Tier: pro."),
      "rendered tier should appear in LLM prompt",
    );
  });

  it("uses defaultValue for slots not provided in negotiationTerms", async () => {
    const { llm, calls } = makeCapturingLLM({ decision: "accept", reason: "ok" });

    const server = new AgentContractServer({
      requirements: slotsRequirements,
      templateContent: "Jurisdiction: {{jurisdiction}}. Tier: {{tier}}.",
      issueToken: async (contractId) => freshToken(contractId),
      llm,
    });

    const req: AcceptRequest = {
      templateId: "org.accordproject.slots-test",
      templateHash: "basehash",
      partyData: { name: "Alice" },
      negotiationTerms: { tier: "enterprise" }, // no jurisdiction → uses defaultValue "US"
    };

    await server.handleAccept(req);

    assert.ok(calls.length > 0, "LLM should have been called");
    const userContent = calls[0]!.messages[0]!.content;
    assert.ok(
      userContent.includes("Jurisdiction: US."),
      "default jurisdiction 'US' should be rendered in LLM prompt",
    );
    assert.ok(
      userContent.includes("Tier: enterprise."),
      "tier should be rendered in LLM prompt",
    );
  });

  it("includes SELECTED VARIANT in LLM prompt when a variant is chosen", async () => {
    const { llm, calls } = makeCapturingLLM({ decision: "accept", reason: "ok" });

    const server = new AgentContractServer({
      requirements: variantsRequirements,
      templateContent: "Template text.",
      issueToken: async (contractId) => freshToken(contractId),
      llm,
    });

    const req: AcceptRequest = {
      templateId: "org.accordproject.variants-test",
      templateHash: "basehash",
      partyData: { name: "Alice" },
      negotiationTerms: { variant: "premium" },
    };

    await server.handleAccept(req);

    assert.ok(calls.length > 0, "LLM should have been called");
    const userContent = calls[0]!.messages[0]!.content;
    assert.ok(
      userContent.includes("SELECTED VARIANT: premium"),
      "LLM prompt should mention selected variant",
    );
  });
});
