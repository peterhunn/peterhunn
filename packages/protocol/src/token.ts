import type { AgreementPayload, AgreementToken } from "./types.js";
import { b64encode, b64decode } from "./codec.js";

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyHmacHex(secret: string, data: string, hex: string): Promise<boolean> {
  const expected = await hmacHex(secret, data);
  if (expected.length !== hex.length) return false;
  // constant-time comparison
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ hex.charCodeAt(i);
  }
  return diff === 0;
}

/** Issue a signed agreement token. Called by the server's accept endpoint. */
export async function signToken(payload: AgreementPayload, secret: string): Promise<string> {
  const body = JSON.stringify(payload);
  const signature = await hmacHex(secret, body);
  const token: AgreementToken = { scheme: "x480", payload, signature };
  return b64encode(JSON.stringify(token));
}

export type VerifyOk = { valid: true; payload: AgreementPayload };
export type VerifyFail = { valid: false; reason: string };

/**
 * Verify an X-Contract-Agreement header value.
 *
 * Checks scheme, expiry, resource match, and HMAC signature.
 * Pass resource="*" to skip resource-path checking (facilitator mode).
 */
export async function verifyToken(
  raw: string,
  secret: string,
  resource: string,
): Promise<VerifyOk | VerifyFail> {
  let token: AgreementToken;
  try {
    token = JSON.parse(b64decode(raw)) as AgreementToken;
  } catch {
    return { valid: false, reason: "malformed token" };
  }

  if (token.scheme !== "x480") {
    return { valid: false, reason: "unknown scheme" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (token.payload.exp < now) {
    return { valid: false, reason: "token expired" };
  }

  if (
    resource !== "*" &&
    token.payload.resource !== "*" &&
    token.payload.resource !== resource
  ) {
    return { valid: false, reason: "resource mismatch" };
  }

  const ok = await verifyHmacHex(secret, JSON.stringify(token.payload), token.signature);
  if (!ok) return { valid: false, reason: "invalid signature" };

  return { valid: true, payload: token.payload };
}

/** Decode a raw token string without verifying the signature (for inspection only). */
export function decodeToken(raw: string): AgreementToken | null {
  try {
    return JSON.parse(b64decode(raw)) as AgreementToken;
  } catch {
    return null;
  }
}
