import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM envelope for credential blobs. Master key comes from
// ATELIER_CREDENTIAL_KEY (32 bytes as 64 hex chars) or is passed
// into credentialRepo explicitly by tests.
//
// Stored shape:
//   { "v": 1, "cipher": "<iv-b64>:<authTag-b64>:<ciphertext-b64>" }
//
// The version prefix lets us rotate algorithms without ambiguity —
// a future v2 (e.g. envelope encryption with a KMS-wrapped data
// key per row) coexists with v1 rows via the version dispatch on
// decrypt.
//
// Any row that doesn't parse as this shape is treated as a legacy
// plaintext credential from the pre-encryption era. The repo logs
// a one-time warning and upgrades it transparently on the next
// write.

const ALGO = "aes-256-gcm";
const IV_BYTES = 12; // GCM standard nonce length

export interface EncryptedCredential {
  readonly v: 1;
  readonly cipher: string;
}

export const isEncryptedCredential = (v: unknown): v is EncryptedCredential => {
  if (!v || typeof v !== "object") return false;
  const rec = v as Record<string, unknown>;
  return rec["v"] === 1 && typeof rec["cipher"] === "string";
};

export const parseMasterKey = (raw: string | undefined): Buffer => {
  if (!raw) {
    throw new Error(
      "ATELIER_CREDENTIAL_KEY is required for the credentials repo. " +
        "Generate one with: openssl rand -hex 32",
    );
  }
  const trimmed = raw.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error(
      "ATELIER_CREDENTIAL_KEY must be 32 bytes hex-encoded (64 hex chars).",
    );
  }
  return Buffer.from(trimmed, "hex");
};

export const encryptCredential = (
  key: Buffer,
  plaintext: Record<string, unknown>,
): EncryptedCredential => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const plain = Buffer.from(JSON.stringify(plaintext), "utf-8");
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    cipher: `${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`,
  };
};

export const decryptCredential = (
  key: Buffer,
  wrapped: EncryptedCredential,
): Record<string, unknown> => {
  const parts = wrapped.cipher.split(":");
  if (parts.length !== 3) throw new Error("malformed credential ciphertext");
  const iv = Buffer.from(parts[0]!, "base64");
  const tag = Buffer.from(parts[1]!, "base64");
  const ct = Buffer.from(parts[2]!, "base64");
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(plain.toString("utf-8")) as Record<string, unknown>;
};
