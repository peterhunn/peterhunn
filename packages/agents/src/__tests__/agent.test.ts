import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import { defineModel, defineTemplate, initialState } from "@x490/core";
import type { ContractData, ContractEvent, ContractResponse, ContractState } from "@x490/core";
import type { ContractLogic } from "@x490/core";
import { ContractAgent } from "../agent.js";
import type { LLMClient } from "../llm.js";
import type { ContractAnalysis, ComplianceResult, NegotiationSuggestion } from "../agent.js";

// ── Test data types ───────────────────────────────────────────────────────────

interface NdaData extends ContractData {
  $class: "test.Nda";
  disclosingParty: string;
  receivingParty: string;
}

interface NdaEvent extends ContractEvent {
  $class: "test.NdaEvent";
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ndaModel = defineModel<NdaData>(
  { namespace: "test", name: "Nda", version: "1.0.0" },
  (d): d is NdaData =>
    typeof d === "object" &&
    d !== null &&
    (d as Record<string, unknown>)["$class"] === "test.Nda",
);

const ndaTemplate = defineTemplate<NdaData>(
  ndaModel,
  "NDA between {{disclosingParty}} and {{receivingParty}}.",
);

const sampleData: NdaData = {
  $class: "test.Nda",
  disclosingParty: "Acme Corp",
  receivingParty: "Beta LLC",
};

function makeMockLlm(response: string): LLMClient {
  return {
    complete: async () => ({ content: response, stopReason: "end_turn" }),
  };
}

function makeNoOpLogic(): ContractLogic<NdaData, NdaEvent> {
  return {
    execute(_event, ctx): ContractResponse<null> {
      return { state: ctx.state, result: null };
    },
  };
}

function makeAgent(llmResponse: string) {
  return new ContractAgent<NdaData, NdaEvent>(
    ndaTemplate,
    makeNoOpLogic(),
    makeMockLlm(llmResponse),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// draft
// ─────────────────────────────────────────────────────────────────────────────

describe("ContractAgent.draft", () => {
  it("substitutes variables correctly", () => {
    const agent = makeAgent("unused");
    const text = agent.draft(sampleData);
    assert.strictEqual(text, "NDA between Acme Corp and Beta LLC.");
  });

  it("leaves unresolved variables as-is", () => {
    const agent = makeAgent("unused");
    const partial = {
      $class: "test.Nda",
      disclosingParty: "Acme Corp",
      // receivingParty intentionally omitted
    } as unknown as NdaData;
    const text = agent.draft(partial);
    assert.ok(text.includes("{{receivingParty}}"), `expected placeholder in: ${text}`);
  });

  it("does not call the LLM", () => {
    let called = false;
    const agent = new ContractAgent<NdaData, NdaEvent>(
      ndaTemplate,
      makeNoOpLogic(),
      {
        complete: async () => {
          called = true;
          return { content: "", stopReason: "end_turn" };
        },
      },
    );
    agent.draft(sampleData);
    assert.strictEqual(called, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parse
// ─────────────────────────────────────────────────────────────────────────────

describe("ContractAgent.parse", () => {
  it("returns LLM-extracted data when LLM returns valid JSON fenced block", async () => {
    const llmJson = { disclosingParty: "LLM Corp", receivingParty: "LLM LLC" };
    const agent = makeAgent("```json\n" + JSON.stringify(llmJson) + "\n```");
    const result = await agent.parse("NDA between LLM Corp and LLM LLC.");
    assert.strictEqual(result.disclosingParty, "LLM Corp");
    assert.strictEqual(result.receivingParty, "LLM LLC");
  });

  it("returns LLM-extracted data when LLM returns plain JSON (no fences)", async () => {
    const llmJson = { disclosingParty: "Plain Corp", receivingParty: "Plain LLC" };
    const agent = makeAgent(JSON.stringify(llmJson));
    const result = await agent.parse("NDA between Plain Corp and Plain LLC.");
    assert.strictEqual(result.disclosingParty, "Plain Corp");
    assert.strictEqual(result.receivingParty, "Plain LLC");
  });

  it("falls back to heuristic when LLM returns non-JSON", async () => {
    // Template: "NDA between {{disclosingParty}} and {{receivingParty}}."
    // The heuristic parser uses surrounding literal text as anchors.
    const contractText = "NDA between Heuristic Corp and Heuristic LLC.";
    const agent = makeAgent("sorry, I cannot parse that contract");
    const result = await agent.parse(contractText);
    // The heuristic should extract something (even if partial); the LLM error
    // should not propagate — we just verify no exception and the result is an object.
    assert.ok(typeof result === "object" && result !== null);
  });

  it("merges heuristic and LLM results — LLM wins on conflict", async () => {
    // The heuristic will extract parties from the contract text.
    // The LLM returns different (overriding) values.
    const llmJson = { disclosingParty: "LLM Winner", receivingParty: "Beta LLC" };
    const agent = makeAgent(JSON.stringify(llmJson));
    const result = await agent.parse("NDA between Heuristic Corp and Beta LLC.");
    // LLM value should win over heuristic for disclosingParty
    assert.strictEqual(result.disclosingParty, "LLM Winner");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// analyze
// ─────────────────────────────────────────────────────────────────────────────

describe("ContractAgent.analyze", () => {
  const validAnalysis: ContractAnalysis = {
    summary: "This is an NDA.",
    parties: [{ name: "Acme Corp", role: "disclosing" }],
    obligations: [],
    risks: ["broad scope"],
    missingClauses: ["governing law"],
  };

  it("returns parsed ContractAnalysis when LLM returns valid JSON", async () => {
    const agent = makeAgent("```json\n" + JSON.stringify(validAnalysis) + "\n```");
    const result = await agent.analyze("NDA between Acme Corp and Beta LLC.");
    assert.strictEqual(result.summary, validAnalysis.summary);
    assert.deepStrictEqual(result.parties, validAnalysis.parties);
    assert.deepStrictEqual(result.risks, validAnalysis.risks);
  });

  it("passes contract text to LLM", async () => {
    let capturedMessages: unknown[] = [];
    const agent = new ContractAgent<NdaData, NdaEvent>(
      ndaTemplate,
      makeNoOpLogic(),
      {
        complete: async (_sys, messages) => {
          capturedMessages = messages;
          return {
            content: "```json\n" + JSON.stringify(validAnalysis) + "\n```",
            stopReason: "end_turn",
          };
        },
      },
    );
    const contractText = "NDA between Acme Corp and Beta LLC.";
    await agent.analyze(contractText);
    const firstMsg = capturedMessages[0] as { content: string };
    assert.ok(
      firstMsg.content.includes(contractText),
      "expected contract text in LLM message",
    );
  });

  it("throws when LLM returns non-JSON", async () => {
    const agent = makeAgent("I am unable to analyze that.");
    await assert.rejects(
      () => agent.analyze("NDA between Acme Corp and Beta LLC."),
      /SyntaxError|Unexpected token|JSON/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkCompliance
// ─────────────────────────────────────────────────────────────────────────────

describe("ContractAgent.checkCompliance", () => {
  const passedResult: ComplianceResult = {
    passed: true,
    results: [
      { requirement: "Must be mutual", satisfied: true, explanation: "Both parties bound." },
    ],
  };

  const failedResult: ComplianceResult = {
    passed: false,
    results: [
      { requirement: "Duration ≤ 2 years", satisfied: false, explanation: "Duration is 5 years." },
    ],
  };

  it("returns ComplianceResult with passed:true when LLM says so", async () => {
    const agent = makeAgent(JSON.stringify(passedResult));
    const result = await agent.checkCompliance("some contract text", ["Must be mutual"]);
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.results.length, 1);
  });

  it("returns passed:false when LLM says so", async () => {
    const agent = makeAgent(JSON.stringify(failedResult));
    const result = await agent.checkCompliance("some contract text", ["Duration ≤ 2 years"]);
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.results[0]?.satisfied, false);
  });

  it("passes requirements list to LLM prompt", async () => {
    let capturedContent = "";
    const requirements = ["Must be mutual", "Governing law clause required"];
    const agent = new ContractAgent<NdaData, NdaEvent>(
      ndaTemplate,
      makeNoOpLogic(),
      {
        complete: async (_sys, messages) => {
          capturedContent = (messages[0] as { content: string }).content;
          return { content: JSON.stringify(passedResult), stopReason: "end_turn" };
        },
      },
    );
    await agent.checkCompliance("some contract", requirements);
    for (const req of requirements) {
      assert.ok(capturedContent.includes(req), `expected requirement "${req}" in prompt`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// negotiate
// ─────────────────────────────────────────────────────────────────────────────

describe("ContractAgent.negotiate", () => {
  const suggestions: NegotiationSuggestion[] = [
    {
      clause: "Clause 1",
      issue: "Too broad",
      suggestion: "Narrow the scope",
      priority: "high",
    },
    {
      clause: "Clause 2",
      issue: "Missing deadline",
      suggestion: "Add a 30-day deadline",
      priority: "medium",
    },
  ];

  it("returns NegotiationSuggestion[] from LLM response", async () => {
    const agent = makeAgent(JSON.stringify(suggestions));
    const result = await agent.negotiate("NDA between Acme Corp and Beta LLC.");
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0]?.clause, "Clause 1");
    assert.strictEqual(result[0]?.priority, "high");
  });

  it("defaults to neutral perspective", async () => {
    let capturedContent = "";
    const agent = new ContractAgent<NdaData, NdaEvent>(
      ndaTemplate,
      makeNoOpLogic(),
      {
        complete: async (_sys, messages) => {
          capturedContent = (messages[0] as { content: string }).content;
          return { content: JSON.stringify(suggestions), stopReason: "end_turn" };
        },
      },
    );
    await agent.negotiate("some contract text");
    assert.ok(capturedContent.includes("neutral"), `expected "neutral" in prompt: ${capturedContent}`);
  });

  it("passes perspective to LLM prompt", async () => {
    let capturedContent = "";
    const agent = new ContractAgent<NdaData, NdaEvent>(
      ndaTemplate,
      makeNoOpLogic(),
      {
        complete: async (_sys, messages) => {
          capturedContent = (messages[0] as { content: string }).content;
          return { content: JSON.stringify(suggestions), stopReason: "end_turn" };
        },
      },
    );
    await agent.negotiate("some contract text", "disclosing");
    assert.ok(
      capturedContent.includes("disclosing"),
      `expected "disclosing" in prompt: ${capturedContent}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// activate
// ─────────────────────────────────────────────────────────────────────────────

describe("ContractAgent.activate", () => {
  it("returns initialState() when logic has no init()", () => {
    const agent = makeAgent("unused");
    const state = agent.activate(sampleData);
    assert.strictEqual(state.status, "active");
    assert.deepStrictEqual(state.obligations, []);
    assert.deepStrictEqual(state.history, []);
  });

  it("calls logic.init(data) when present", () => {
    let initCalledWith: NdaData | null = null;
    const logicWithInit: ContractLogic<NdaData, NdaEvent> = {
      init(data) {
        initCalledWith = data;
        return initialState({ status: "active", data: { custom: true } });
      },
      execute(_event, ctx) {
        return { state: ctx.state, result: null };
      },
    };
    const agent = new ContractAgent<NdaData, NdaEvent>(
      ndaTemplate,
      logicWithInit,
      makeMockLlm("unused"),
    );
    agent.activate(sampleData);
    assert.deepStrictEqual(initCalledWith, sampleData);
  });

  it("returns state with status 'active' by default", () => {
    const agent = makeAgent("unused");
    const state = agent.activate(sampleData);
    assert.strictEqual(state.status, "active");
  });

  it("stateId is unique per call", () => {
    const agent = makeAgent("unused");
    const state1 = agent.activate(sampleData);
    const state2 = agent.activate(sampleData);
    assert.notStrictEqual(state1.stateId, state2.stateId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// execute
// ─────────────────────────────────────────────────────────────────────────────

describe("ContractAgent.execute", () => {
  function makeEvent(): NdaEvent {
    return {
      $class: "test.NdaEvent",
      eventId: "evt-1",
      timestamp: new Date().toISOString(),
      payload: {},
    };
  }

  it("calls logic.execute with event, data, and state", () => {
    let capturedEvent: NdaEvent | null = null;
    let capturedData: NdaData | null = null;
    let capturedState: ContractState | null = null;

    const logic: ContractLogic<NdaData, NdaEvent> = {
      execute(event, ctx) {
        capturedEvent = event;
        capturedData = ctx.data;
        capturedState = ctx.state;
        return { state: ctx.state, result: null };
      },
    };

    const agent = new ContractAgent<NdaData, NdaEvent>(
      ndaTemplate,
      logic,
      makeMockLlm("unused"),
    );

    const state = initialState();
    const event = makeEvent();
    agent.execute(event, state, sampleData);

    assert.deepStrictEqual(capturedEvent, event);
    assert.deepStrictEqual(capturedData, sampleData);
    assert.deepStrictEqual(capturedState, state);
  });

  it("returns updated state from logic", () => {
    const updatedState = initialState({ status: "completed" });
    const logic: ContractLogic<NdaData, NdaEvent> = {
      execute(_event, _ctx) {
        return { state: updatedState, result: null };
      },
    };

    const agent = new ContractAgent<NdaData, NdaEvent>(
      ndaTemplate,
      logic,
      makeMockLlm("unused"),
    );

    const response = agent.execute(makeEvent(), initialState(), sampleData);
    assert.strictEqual(response.state.status, "completed");
  });

  it("returns result from logic", () => {
    const logic: ContractLogic<NdaData, NdaEvent, { ok: boolean }> = {
      execute(_event, ctx) {
        return { state: ctx.state, result: { ok: true } };
      },
    };

    const agent = new ContractAgent<NdaData, NdaEvent, { ok: boolean }>(
      ndaTemplate,
      logic,
      makeMockLlm("unused"),
    );

    const response = agent.execute(makeEvent(), initialState(), sampleData);
    assert.deepStrictEqual(response.result, { ok: true });
  });

  it("passes current Date as `now` (approximately)", () => {
    let capturedNow: Date | null = null;
    const before = Date.now();

    const logic: ContractLogic<NdaData, NdaEvent> = {
      execute(_event, ctx) {
        capturedNow = ctx.now;
        return { state: ctx.state, result: null };
      },
    };

    const agent = new ContractAgent<NdaData, NdaEvent>(
      ndaTemplate,
      logic,
      makeMockLlm("unused"),
    );

    agent.execute(makeEvent(), initialState(), sampleData);
    const after = Date.now();

    assert.ok(capturedNow instanceof Date, "now should be a Date");
    assert.ok(
      capturedNow.getTime() >= before && capturedNow.getTime() <= after,
      `now (${capturedNow.toISOString()}) should be between ${before} and ${after}`,
    );
  });

  it("state changes are reflected in returned state", () => {
    const logic: ContractLogic<NdaData, NdaEvent> = {
      execute(_event, ctx) {
        const newState: ContractState = {
          ...ctx.state,
          status: "terminated",
          data: { reason: "breach" },
        };
        return { state: newState, result: null };
      },
    };

    const agent = new ContractAgent<NdaData, NdaEvent>(
      ndaTemplate,
      logic,
      makeMockLlm("unused"),
    );

    const initial = initialState();
    const response = agent.execute(makeEvent(), initial, sampleData);

    assert.strictEqual(response.state.status, "terminated");
    assert.deepStrictEqual(response.state.data, { reason: "breach" });
    // Original state should not be mutated
    assert.strictEqual(initial.status, "active");
  });
});
