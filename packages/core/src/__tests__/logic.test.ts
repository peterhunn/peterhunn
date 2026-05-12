import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { initialState } from "../logic.js";

describe("initialState", () => {
  it("returns status active by default", () => {
    const s = initialState();
    assert.equal(s.status, "active");
  });

  it("returns empty obligations and history by default", () => {
    const s = initialState();
    assert.deepEqual(s.obligations, []);
    assert.deepEqual(s.history, []);
  });

  it("generates a stateId", () => {
    const s = initialState();
    assert.equal(typeof s.stateId, "string");
    assert.ok(s.stateId.length > 0);
  });

  it("each call generates a unique stateId", () => {
    const s1 = initialState();
    const s2 = initialState();
    assert.notEqual(s1.stateId, s2.stateId);
  });

  it("applies overrides", () => {
    const s = initialState({ status: "terminated", data: { note: "overridden" } });
    assert.equal(s.status, "terminated");
    assert.deepEqual(s.data, { note: "overridden" });
  });

  it("override stateId is respected", () => {
    const s = initialState({ stateId: "fixed-id" });
    assert.equal(s.stateId, "fixed-id");
  });

  it("overrides do not affect other fields", () => {
    const s = initialState({ status: "breached" });
    assert.deepEqual(s.obligations, []);
    assert.deepEqual(s.history, []);
  });
});
