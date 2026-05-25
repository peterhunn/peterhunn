import type { PaymentRequirements, PaymentProof } from "./types.js";

// base64url encode without padding
function b64urlEncode(json: string): string {
  const bytes = Buffer.from(json, "utf-8");
  return bytes
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

// base64url decode (with or without padding)
function b64urlDecode(encoded: string): string {
  // Add padding if needed
  const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
  const normalized = padded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf-8");
}

export function encodeRequirements(req: PaymentRequirements): string {
  return b64urlEncode(JSON.stringify(req));
}

export function decodeRequirements(encoded: string): PaymentRequirements {
  return JSON.parse(b64urlDecode(encoded)) as PaymentRequirements;
}

export function encodeProof(proof: PaymentProof): string {
  return b64urlEncode(JSON.stringify(proof));
}

export function decodeProof(encoded: string): PaymentProof {
  return JSON.parse(b64urlDecode(encoded)) as PaymentProof;
}
