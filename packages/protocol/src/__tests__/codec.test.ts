import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { b64encode, b64decode } from "../codec.js";

describe("codec", () => {
  it("roundtrips ASCII", () => {
    const s = "hello world";
    assert.equal(b64decode(b64encode(s)), s);
  });

  it("roundtrips Unicode (em dash, curly quotes)", () => {
    const s = `Data Use NDA — "required" before access`;
    assert.equal(b64decode(b64encode(s)), s);
  });

  it("roundtrips arbitrary JSON", () => {
    const obj = { scheme: "x490", version: 1, emoji: "\u{1F4DC}" };
    const s = JSON.stringify(obj);
    assert.equal(b64decode(b64encode(s)), s);
  });

  it("produces different output for different inputs", () => {
    assert.notEqual(b64encode("a"), b64encode("b"));
  });

  it("b64encode output is valid base64 (no non-base64 characters)", () => {
    const encoded = b64encode("test string with spaces");
    assert.match(encoded, /^[A-Za-z0-9+/]+=*$/);
  });
});
