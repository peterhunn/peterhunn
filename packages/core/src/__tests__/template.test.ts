import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defineTemplate } from "../template.js";
import { defineModel } from "../model.js";
import type { ContractData } from "../types.js";

interface NDAData extends ContractData {
  $class: "org.test.NDA";
  discloser: string;
  recipient: string;
  jurisdiction: string;
}

const NDAModel = defineModel<NDAData>(
  { namespace: "org.test", name: "NDA", version: "1.0.0" },
  (d): d is NDAData =>
    !!d && typeof d === "object" &&
    (d as Record<string, unknown>)["$class"] === "org.test.NDA",
);

const templateText = `This Non-Disclosure Agreement is entered into between {{discloser}} (the "Discloser") and {{recipient}} (the "Recipient") under the laws of {{jurisdiction}}.`;

const template = defineTemplate(NDAModel, templateText);

describe("defineTemplate.variables()", () => {
  it("lists all variable paths in the template", () => {
    const vars = template.variables();
    assert.ok(vars.includes("discloser"));
    assert.ok(vars.includes("recipient"));
    assert.ok(vars.includes("jurisdiction"));
    assert.equal(vars.length, 3);
  });

  it("deduplicates repeated variables", () => {
    const t = defineTemplate(NDAModel, "{{discloser}} and {{discloser}}");
    assert.equal(t.variables().length, 1);
  });
});

describe("defineTemplate.draft()", () => {
  const data: NDAData = {
    $class: "org.test.NDA",
    discloser: "Acme Corp",
    recipient: "Beta Inc",
    jurisdiction: "California",
  };

  it("renders all variables from data", () => {
    const rendered = template.draft(data);
    assert.ok(rendered.includes("Acme Corp"));
    assert.ok(rendered.includes("Beta Inc"));
    assert.ok(rendered.includes("California"));
  });

  it("leaves unreferenced {{placeholders}} intact when data key is missing", () => {
    const t = defineTemplate(NDAModel, "Hello {{missingKey}}");
    const rendered = t.draft(data);
    assert.ok(rendered.includes("{{missingKey}}"));
  });

  it("does not contain raw {{variable}} placeholders for known fields", () => {
    const rendered = template.draft(data);
    assert.ok(!rendered.includes("{{discloser}}"));
    assert.ok(!rendered.includes("{{recipient}}"));
    assert.ok(!rendered.includes("{{jurisdiction}}"));
  });
});

describe("defineTemplate.parse()", () => {
  it("extracts variable values from rendered contract text", () => {
    const data: NDAData = {
      $class: "org.test.NDA",
      discloser: "Acme Corp",
      recipient: "Beta Inc",
      jurisdiction: "California",
    };
    const rendered = template.draft(data);
    const parsed = template.parse(rendered);
    assert.equal(parsed.discloser, "Acme Corp");
    assert.equal(parsed.recipient, "Beta Inc");
    assert.equal(parsed.jurisdiction, "California");
  });
});

describe("defineTemplate with nested path", () => {
  interface WithNested extends ContractData {
    $class: "org.test.Nested";
    party: { name: string };
  }
  const NestedModel = defineModel<WithNested>(
    { namespace: "org.test", name: "Nested", version: "1.0.0" },
    (d): d is WithNested => !!d && typeof d === "object",
  );
  const t = defineTemplate(NestedModel, "Signed by {{party.name}}.");

  it("renders nested path", () => {
    const data: WithNested = { $class: "org.test.Nested", party: { name: "Alice" } };
    assert.ok(t.draft(data).includes("Alice"));
  });

  it("lists nested path in variables()", () => {
    assert.ok(t.variables().includes("party.name"));
  });
});
