import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defineModel } from "../model.js";
import type { ContractData } from "../types.js";

interface TestContract extends ContractData {
  $class: "org.test.TestContract";
  title: string;
  value: number;
}

function isTestContract(data: unknown): data is TestContract {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return d["$class"] === "org.test.TestContract" && typeof d["title"] === "string" && typeof d["value"] === "number";
}

const TestContractModel = defineModel<TestContract>(
  { namespace: "org.test", name: "TestContract", version: "1.0.0", description: "Test" },
  isTestContract,
);

const sampleData: TestContract = {
  $class: "org.test.TestContract",
  title: "My Agreement",
  value: 42,
};

describe("defineModel", () => {
  it("preserves meta fields", () => {
    assert.equal(TestContractModel.meta.namespace, "org.test");
    assert.equal(TestContractModel.meta.name, "TestContract");
    assert.equal(TestContractModel.meta.version, "1.0.0");
  });

  it("is() returns true for valid data", () => {
    assert.ok(TestContractModel.is(sampleData));
  });

  it("is() returns false for invalid data", () => {
    assert.ok(!TestContractModel.is({ $class: "other", title: 123 }));
    assert.ok(!TestContractModel.is(null));
    assert.ok(!TestContractModel.is("string"));
  });

  it("serialize() returns a JSON string", () => {
    const json = TestContractModel.serialize(sampleData);
    assert.equal(typeof json, "string");
    const parsed = JSON.parse(json) as unknown;
    assert.deepEqual(parsed, sampleData);
  });

  it("deserialize() returns valid typed data", () => {
    const json = TestContractModel.serialize(sampleData);
    const result = TestContractModel.deserialize(json);
    assert.deepEqual(result, sampleData);
  });

  it("deserialize() throws on invalid JSON structure", () => {
    const badJson = JSON.stringify({ $class: "wrong", title: "x", value: "not-a-number" });
    assert.throws(() => TestContractModel.deserialize(badJson), /Invalid contract data/);
  });

  it("deserialize() throws on non-JSON input", () => {
    assert.throws(() => TestContractModel.deserialize("not json"));
  });

  it("serialize/deserialize roundtrip preserves all fields", () => {
    const data: TestContract = { $class: "org.test.TestContract", title: "Round trip", value: 99 };
    const result = TestContractModel.deserialize(TestContractModel.serialize(data));
    assert.deepEqual(result, data);
  });
});
