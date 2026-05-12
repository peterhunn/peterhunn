import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { signToken, verifyToken, decodeToken } from "../token.js";
import type { AgreementPayload } from "../types.js";

const SECRET = "test-hmac-secret";
const now = Math.floor(Date.now() / 1000);

function makePayload(overrides: Partial<AgreementPayload> = {}): AgreementPayload {
  return {
    contractId: "cid-1",
    templateHash: "abc123",
    partyId: "party-a",
    resource: "/data",
    iat: now,
    exp: now + 3600,
    ...overrides,
  };
}

describe("signToken", () => {
  it("returns a base64 string", async () => {
    const token = await signToken(makePayload(), SECRET);
    assert.match(token, /^[A-Za-z0-9+/]+=*$/);
  });

  it("encodes a parseable AgreementToken", async () => {
    const payload = makePayload();
    const token = await signToken(payload, SECRET);
    const decoded = decodeToken(token);
    assert.ok(decoded);
    assert.equal(decoded.scheme, "x490");
    assert.equal(decoded.payload.contractId, payload.contractId);
    assert.equal(decoded.payload.partyId, payload.partyId);
    assert.equal(typeof decoded.signature, "string");
    assert.ok(decoded.signature.length > 0);
  });
});

describe("verifyToken", () => {
  it("accepts a valid token", async () => {
    const token = await signToken(makePayload(), SECRET);
    const result = await verifyToken(token, SECRET, "/data");
    assert.ok(result.valid);
    if (result.valid) assert.equal(result.payload.contractId, "cid-1");
  });

  it("rejects an expired token", async () => {
    const token = await signToken(makePayload({ exp: now - 1 }), SECRET);
    const result = await verifyToken(token, SECRET, "/data");
    assert.ok(!result.valid);
    if (!result.valid) assert.equal(result.reason, "token expired");
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signToken(makePayload(), SECRET);
    const result = await verifyToken(token, "wrong-secret", "/data");
    assert.ok(!result.valid);
    if (!result.valid) assert.equal(result.reason, "invalid signature");
  });

  it("rejects a resource mismatch", async () => {
    const token = await signToken(makePayload({ resource: "/data" }), SECRET);
    const result = await verifyToken(token, SECRET, "/other-path");
    assert.ok(!result.valid);
    if (!result.valid) assert.equal(result.reason, "resource mismatch");
  });

  it("accepts any resource when token resource is wildcard", async () => {
    const token = await signToken(makePayload({ resource: "*" }), SECRET);
    const result = await verifyToken(token, SECRET, "/any/path");
    assert.ok(result.valid);
  });

  it("accepts any resource when verifier passes wildcard", async () => {
    const token = await signToken(makePayload({ resource: "/data" }), SECRET);
    const result = await verifyToken(token, SECRET, "*");
    assert.ok(result.valid);
  });

  it("rejects malformed base64", async () => {
    const result = await verifyToken("not-valid-base64!!!", SECRET, "/data");
    assert.ok(!result.valid);
    if (!result.valid) assert.equal(result.reason, "malformed token");
  });

  it("rejects a token with unknown scheme", async () => {
    const payload = makePayload();
    const token = await signToken(payload, SECRET);
    const decoded = decodeToken(token)!;
    // tamper the scheme
    const tampered = Buffer.from(
      JSON.stringify({ ...decoded, scheme: "x999" }),
    ).toString("base64");
    const result = await verifyToken(tampered, SECRET, "/data");
    assert.ok(!result.valid);
    if (!result.valid) assert.equal(result.reason, "unknown scheme");
  });
});

describe("decodeToken", () => {
  it("returns AgreementToken for a valid token", async () => {
    const token = await signToken(makePayload(), SECRET);
    const decoded = decodeToken(token);
    assert.ok(decoded !== null);
    assert.equal(decoded?.scheme, "x490");
  });

  it("returns null for garbage input", () => {
    assert.equal(decodeToken("garbage"), null);
  });

  it("returns null for empty string", () => {
    assert.equal(decodeToken(""), null);
  });
});
