import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildX402WithContract,
  parseX402Response,
  x490ExtensionHeaders,
  extractContractRequirements,
} from "../x402.js";
import { b64encode } from "../codec.js";
import type { ContractRequirements, X402PaymentRequirement } from "../types.js";

const sampleRequirements: ContractRequirements = {
  scheme: "x490",
  version: 1,
  templateId: "org.accordproject.nda",
  templateUrl: "https://example.com/template",
  templateHash: "abc123",
  requiredPartyFields: ["name"],
  acceptEndpoint: "https://example.com/accept",
  expiresIn: 3600,
  resource: "/data",
  description: "Test NDA",
  negotiable: false,
};

const samplePayment: X402PaymentRequirement = {
  scheme: "exact",
  network: "base",
  maxAmountRequired: "1000000",
  resource: "/data",
  description: "Pay",
  payTo: "0x0000000000000000000000000000000000000000",
  maxTimeoutSeconds: 300,
};

describe("buildX402WithContract", () => {
  it("embeds contractRequired in the x402 body", () => {
    const body = buildX402WithContract([samplePayment], sampleRequirements);
    assert.equal(body.x402Version, 1);
    assert.deepEqual(body.accepts, [samplePayment]);
    assert.deepEqual(body.contractRequired, sampleRequirements);
    assert.equal(body.error, null);
  });
});

describe("parseX402Response", () => {
  it("parses a body that includes contractRequired", () => {
    const raw = {
      accepts: [samplePayment],
      contractRequired: sampleRequirements,
      error: null,
    };
    const parsed = parseX402Response(raw);
    assert.deepEqual(parsed.contractRequired, sampleRequirements);
    assert.deepEqual(parsed.accepts, [samplePayment]);
  });

  it("handles a body without contractRequired", () => {
    const raw = { accepts: [samplePayment], error: null };
    const parsed = parseX402Response(raw);
    assert.equal(parsed.contractRequired, undefined);
  });
});

describe("x490ExtensionHeaders", () => {
  it("returns X-490-Requirements header with base64 JSON", () => {
    const headers = x490ExtensionHeaders(sampleRequirements);
    assert.ok("X-490-Requirements" in headers);
    const decoded = JSON.parse(atob(headers["X-490-Requirements"]!));
    assert.equal(decoded.scheme, "x490");
    assert.equal(decoded.templateId, sampleRequirements.templateId);
  });
});

describe("extractContractRequirements", () => {
  it("extracts from X-490-Requirements header", async () => {
    const headerVal = b64encode(JSON.stringify(sampleRequirements));
    const response = new Response(JSON.stringify({}), {
      headers: { "X-490-Requirements": headerVal },
    });
    const req = await extractContractRequirements(response);
    assert.ok(req !== undefined);
    assert.equal(req?.templateId, sampleRequirements.templateId);
  });

  it("falls back to body when header is absent", async () => {
    const body = buildX402WithContract([samplePayment], sampleRequirements);
    const response = new Response(JSON.stringify(body));
    const req = await extractContractRequirements(response);
    assert.ok(req !== undefined);
    assert.equal(req?.scheme, "x490");
  });

  it("returns undefined for a plain 402 response", async () => {
    const body = { x402Version: 1, accepts: [samplePayment], error: null };
    const response = new Response(JSON.stringify(body));
    const req = await extractContractRequirements(response);
    assert.equal(req, undefined);
  });
});
