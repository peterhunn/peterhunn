import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import {
  encodeRequirements,
  decodeRequirements,
  encodeProof,
  decodeProof,
} from "../codec.js";
import { requirePayment } from "../middleware.js";
import { X402Client } from "../client.js";
import { verifyPaymentOffline } from "../verify.js";
import type { PaymentRequirements, PaymentProof } from "../types.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const NOW = Math.floor(Date.now() / 1000);

const requirements: PaymentRequirements = {
  version: 1,
  scheme: "exact",
  network: "base",
  maxAmountRequired: "1000000",
  resource: "/api/data",
  description: "Access to premium data",
  payTo: "0xRecipient000000000000000000000000000000",
  maxTimeoutSeconds: 60,
  asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  extra: { name: "USDC", decimals: 6 },
};

const validSig =
  "0x" + "a".repeat(130); // 65 bytes in hex, EIP-712 sig format

const validProof: PaymentProof = {
  x402Version: 1,
  scheme: "exact",
  network: "base",
  payload: {
    signature: validSig,
    authorization: {
      from: "0xPayer0000000000000000000000000000000000",
      to: "0xRecipient000000000000000000000000000000",
      value: "1000000",
      validAfter: String(NOW - 10),
      validBefore: String(NOW + 3600),
      nonce: "0x" + "b".repeat(64),
    },
  },
};

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

// ── 1. encodeRequirements / decodeRequirements round-trip ─────────────────────

describe("encodeRequirements / decodeRequirements", () => {
  it("round-trips a PaymentRequirements object", () => {
    const encoded = encodeRequirements(requirements);
    assert.ok(typeof encoded === "string", "should return a string");
    // base64url: no padding, no +, no /
    assert.ok(!/[+/=]/.test(encoded), "should be base64url without padding");

    const decoded = decodeRequirements(encoded);
    assert.deepEqual(decoded, requirements);
  });

  it("produces different output for different inputs", () => {
    const other: PaymentRequirements = { ...requirements, network: "ethereum" };
    assert.notEqual(encodeRequirements(requirements), encodeRequirements(other));
  });
});

// ── 2. encodeProof / decodeProof round-trip ────────────────────────────────────

describe("encodeProof / decodeProof", () => {
  it("round-trips a PaymentProof object", () => {
    const encoded = encodeProof(validProof);
    assert.ok(typeof encoded === "string", "should return a string");
    assert.ok(!/[+/=]/.test(encoded), "should be base64url without padding");

    const decoded = decodeProof(encoded);
    assert.deepEqual(decoded, validProof);
  });

  it("produces different output for different proofs", () => {
    const other: PaymentProof = { ...validProof, network: "ethereum" };
    assert.notEqual(encodeProof(validProof), encodeProof(other));
  });
});

// ── 3. requirePayment middleware: missing header → 402 ────────────────────────

describe("requirePayment — missing X-Payment header", () => {
  it("returns 402 with X-Payment-Required header and JSON body", async () => {
    const app = new Hono();
    app.get("/api/data", requirePayment({ requirements }), (c) => c.text("ok"));

    const res = await app.request("/api/data");
    assert.equal(res.status, 402);

    const headerVal = res.headers.get("X-Payment-Required");
    assert.ok(headerVal, "should have X-Payment-Required header");

    const decodedReqs = decodeRequirements(headerVal);
    assert.deepEqual(decodedReqs, requirements);

    const body = await res.json() as { error: string; requirements: PaymentRequirements };
    assert.equal(body.error, "payment_required");
    assert.deepEqual(body.requirements, requirements);
  });
});

// ── 4. requirePayment middleware: valid proof → calls next() ──────────────────

describe("requirePayment — valid proof calls next()", () => {
  it("passes through when verify returns true", async () => {
    const app = new Hono();
    app.get(
      "/api/data",
      requirePayment({
        requirements,
        verify: async () => true,
      }),
      (c) => c.text("ok"),
    );

    const encodedProof = encodeProof(validProof);
    const res = await app.request("/api/data", {
      headers: { "X-Payment": encodedProof },
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
  });
});

// ── 5. requirePayment middleware: invalid proof → 402 with payment_invalid ────

describe("requirePayment — invalid proof", () => {
  it("returns 402 with payment_invalid when verify returns false", async () => {
    const app = new Hono();
    app.get(
      "/api/data",
      requirePayment({
        requirements,
        verify: async () => false,
      }),
      (c) => c.text("ok"),
    );

    const encodedProof = encodeProof(validProof);
    const res = await app.request("/api/data", {
      headers: { "X-Payment": encodedProof },
    });
    assert.equal(res.status, 402);
    const body = await res.json() as { error: string };
    assert.equal(body.error, "payment_invalid");
  });

  it("returns 402 when X-Payment header is malformed (not valid base64url JSON)", async () => {
    const app = new Hono();
    app.get(
      "/api/data",
      requirePayment({ requirements }),
      (c) => c.text("ok"),
    );

    const res = await app.request("/api/data", {
      headers: { "X-Payment": "!!!not-valid-base64url!!!" },
    });
    assert.equal(res.status, 402);
    const body = await res.json() as { error: string };
    assert.equal(body.error, "payment_required");
  });
});

// ── 6. X402Client.fetch: 200 passthrough ──────────────────────────────────────

describe("X402Client — 200 passthrough", () => {
  it("returns the response when no 402 is encountered", async () => {
    mockFetch(async () => new Response(JSON.stringify({ data: 42 }), { status: 200 }));

    let payCalled = false;
    const client = new X402Client({
      pay: async () => {
        payCalled = true;
        return validProof;
      },
    });

    const res = await client.fetch("https://api.example.com/api/data");
    assert.equal(res.status, 200);
    const body = await res.json() as { data: number };
    assert.equal(body.data, 42);
    assert.ok(!payCalled, "pay should not have been called");
  });
});

// ── 7. X402Client.fetch: 402 → pay → retry → 200 ─────────────────────────────

describe("X402Client — 402 then success after payment", () => {
  it("calls pay() and retries with X-Payment header", async () => {
    const encodedReqs = encodeRequirements(requirements);
    let callCount = 0;
    let capturedPaymentHeader: string | undefined;

    mockFetch(async (_url, init) => {
      callCount++;
      const headers = (init?.headers as Record<string, string> | undefined) ?? {};
      if (headers["X-Payment"]) {
        capturedPaymentHeader = headers["X-Payment"];
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "payment_required" }), {
        status: 402,
        headers: { "X-Payment-Required": encodedReqs },
      });
    });

    let payCalledWith: PaymentRequirements | undefined;
    const client = new X402Client({
      pay: async (reqs) => {
        payCalledWith = reqs;
        return validProof;
      },
    });

    const res = await client.fetch("https://api.example.com/api/data");
    assert.equal(res.status, 200);
    assert.equal(callCount, 2, "should have made 2 fetch calls");
    assert.deepEqual(payCalledWith, requirements, "pay should receive decoded requirements");
    assert.ok(capturedPaymentHeader, "retry should include X-Payment header");
    const decodedReturnedProof = decodeProof(capturedPaymentHeader!);
    assert.deepEqual(decodedReturnedProof, validProof);
  });

  it("throws after exhausting maxRetries", async () => {
    const encodedReqs = encodeRequirements(requirements);

    mockFetch(async () =>
      new Response(JSON.stringify({ error: "payment_required" }), {
        status: 402,
        headers: { "X-Payment-Required": encodedReqs },
      }),
    );

    const client = new X402Client({
      pay: async () => validProof,
      maxRetries: 2,
    });

    await assert.rejects(
      () => client.fetch("https://api.example.com/api/data"),
      /Payment failed after 2 retries/,
    );
  });
});

// ── 8. verifyPaymentOffline ────────────────────────────────────────────────────

describe("verifyPaymentOffline", () => {
  it("returns true for a structurally valid proof", async () => {
    const result = await verifyPaymentOffline(validProof, requirements);
    assert.ok(result, "should be valid");
  });

  it("returns false when validBefore is in the past (expired)", async () => {
    const expiredProof: PaymentProof = {
      ...validProof,
      payload: {
        ...validProof.payload,
        authorization: {
          ...validProof.payload.authorization,
          validBefore: String(NOW - 1),
        },
      },
    };
    const result = await verifyPaymentOffline(expiredProof, requirements);
    assert.ok(!result, "expired proof should be invalid");
  });

  it("returns false when network does not match", async () => {
    const wrongNetworkProof: PaymentProof = {
      ...validProof,
      network: "ethereum",
    };
    const result = await verifyPaymentOffline(wrongNetworkProof, requirements);
    assert.ok(!result, "wrong network should be invalid");
  });

  it("returns false when payment value is too low", async () => {
    const lowValueProof: PaymentProof = {
      ...validProof,
      payload: {
        ...validProof.payload,
        authorization: {
          ...validProof.payload.authorization,
          value: "999999", // one less than required
        },
      },
    };
    const result = await verifyPaymentOffline(lowValueProof, requirements);
    assert.ok(!result, "insufficient payment value should be invalid");
  });

  it("returns false when recipient address does not match payTo", async () => {
    const wrongToProof: PaymentProof = {
      ...validProof,
      payload: {
        ...validProof.payload,
        authorization: {
          ...validProof.payload.authorization,
          to: "0xWrongAddress000000000000000000000000000",
        },
      },
    };
    const result = await verifyPaymentOffline(wrongToProof, requirements);
    assert.ok(!result, "wrong recipient address should be invalid");
  });

  it("returns false when signature is not a valid 0x-prefixed 65-byte hex", async () => {
    const badSigProof: PaymentProof = {
      ...validProof,
      payload: {
        ...validProof.payload,
        signature: "0xdeadbeef",
      },
    };
    const result = await verifyPaymentOffline(badSigProof, requirements);
    assert.ok(!result, "malformed signature should be invalid");
  });

  it("is case-insensitive for the recipient address", async () => {
    const upperCaseToProof: PaymentProof = {
      ...validProof,
      payload: {
        ...validProof.payload,
        authorization: {
          ...validProof.payload.authorization,
          to: validProof.payload.authorization.to.toUpperCase(),
        },
      },
    };
    const result = await verifyPaymentOffline(upperCaseToProof, requirements);
    assert.ok(result, "address comparison should be case-insensitive");
  });
});
