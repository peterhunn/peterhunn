import { describe, it, expect, beforeAll, vi } from "vitest";
import {
  openDb,
  credentialRepo,
  householdRepo,
} from "../src/index.js";
import {
  encryptCredential,
  decryptCredential,
  isEncryptedCredential,
  parseMasterKey,
} from "../src/credential-crypto.js";
import { credentials as credentialsTable } from "../src/schema/credentials.js";
import { eq } from "drizzle-orm";
import type { HouseholdId } from "@atelier/domain";

const TEST_KEY_HEX = "0".repeat(63) + "1";
const KEY = Buffer.from(TEST_KEY_HEX, "hex");

let db: ReturnType<typeof openDb>;
let hh: HouseholdId;

beforeAll(async () => {
  db = openDb({ url: ":memory:" });
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: "./migrations" });
  hh = householdRepo(db).create({ name: "H", tier: "life" }).id;
});

describe("credential crypto primitives", () => {
  it("parseMasterKey requires 64 hex chars", () => {
    expect(() => parseMasterKey(undefined)).toThrow(/required/);
    expect(() => parseMasterKey("")).toThrow(/required/);
    expect(() => parseMasterKey("not-hex")).toThrow(/32 bytes hex/);
    expect(() => parseMasterKey("a".repeat(63))).toThrow(/32 bytes hex/);
    expect(parseMasterKey(TEST_KEY_HEX).byteLength).toBe(32);
  });

  it("encrypt → decrypt round-trips the plaintext", () => {
    const plain = { access_token: "at-live", refresh_token: "rt-live" };
    const wrapped = encryptCredential(KEY, plain);
    expect(isEncryptedCredential(wrapped)).toBe(true);
    expect(wrapped.v).toBe(1);
    expect(wrapped.cipher.split(":")).toHaveLength(3);
    const back = decryptCredential(KEY, wrapped);
    expect(back).toEqual(plain);
  });

  it("decrypt with the wrong key throws (GCM auth tag rejects)", () => {
    const wrapped = encryptCredential(KEY, { secret: "hi" });
    const wrongKey = Buffer.alloc(32, 2);
    expect(() => decryptCredential(wrongKey, wrapped)).toThrow();
  });

  it("two encryptions of the same plaintext produce different ciphertexts (IV randomness)", () => {
    const a = encryptCredential(KEY, { x: "y" });
    const b = encryptCredential(KEY, { x: "y" });
    expect(a.cipher).not.toBe(b.cipher);
  });
});

describe("credentialRepo — encryption at rest", () => {
  it("throws at construction when the master key is missing", () => {
    vi.stubEnv("ATELIER_CREDENTIAL_KEY", "");
    try {
      expect(() => credentialRepo(db)).toThrow(/ATELIER_CREDENTIAL_KEY/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("stores ciphertext in the DB, not the plaintext credential", () => {
    const repo = credentialRepo(db, { key: KEY });
    const summary = repo.store({
      householdId: hh,
      provider: "twilio",
      kind: "api_key",
      label: "Twilio",
      credential: {
        account_sid: "AC-secret",
        auth_token: "tok-do-not-leak",
      },
    });

    // Read the raw row and confirm the DB does NOT hold the
    // plaintext strings anywhere in its stored representation.
    const row = db
      .select()
      .from(credentialsTable)
      .where(eq(credentialsTable.id, summary.id))
      .get();
    expect(row).toBeDefined();
    const raw = JSON.stringify(row!.credential);
    expect(raw).not.toContain("AC-secret");
    expect(raw).not.toContain("tok-do-not-leak");
    expect(isEncryptedCredential(row!.credential)).toBe(true);
  });

  it("getSecret decrypts transparently for the caller", () => {
    const repo = credentialRepo(db, { key: KEY });
    repo.store({
      householdId: hh,
      provider: "gmail",
      kind: "oauth2",
      label: "Gmail",
      credential: {
        access_token: "at-gmail",
        refresh_token: "rt-gmail",
        from_address: "alex@example.com",
      },
    });
    const got = repo.getSecret(hh, "gmail");
    expect(got).not.toBeNull();
    expect(got!.credential["access_token"]).toBe("at-gmail");
    expect(got!.credential["refresh_token"]).toBe("rt-gmail");
    expect(got!.credential["from_address"]).toBe("alex@example.com");
  });

  it("updateAccessToken re-encrypts with the new access token merged in", () => {
    const repo = credentialRepo(db, { key: KEY });
    const stored = repo.store({
      householdId: hh,
      provider: "google_calendar",
      kind: "oauth2",
      label: "Cal",
      credential: {
        access_token: "old-at",
        refresh_token: "keep-rt",
        calendar_id: "primary",
      },
    });
    repo.updateAccessToken(
      stored.id,
      "fresh-at",
      new Date(Date.now() + 3600_000).toISOString(),
    );
    const got = repo.getSecret(hh, "google_calendar");
    expect(got!.credential["access_token"]).toBe("fresh-at");
    // refresh_token + calendar_id preserved through the update.
    expect(got!.credential["refresh_token"]).toBe("keep-rt");
    expect(got!.credential["calendar_id"]).toBe("primary");

    // On-disk row is still ciphertext.
    const row = db
      .select()
      .from(credentialsTable)
      .where(eq(credentialsTable.id, stored.id))
      .get();
    const raw = JSON.stringify(row!.credential);
    expect(raw).not.toContain("fresh-at");
    expect(raw).not.toContain("keep-rt");
  });

  it("migrateLegacyRows upgrades a pre-existing plaintext row and reports the count", () => {
    // Simulate a pre-encryption row by writing plaintext JSON
    // directly through drizzle (bypassing the repo).
    db.insert(credentialsTable)
      .values({
        id: "crd_legacy_1",
        householdId: hh,
        provider: "legacy",
        kind: "api_key",
        label: "Legacy",
        principalRef: null,
        credential: { access_token: "legacy-at", scope: "legacy" } as never,
        scopes: [],
        createdAt: new Date().toISOString(),
        expiresAt: null,
      })
      .run();

    let legacyReads = 0;
    const repo = credentialRepo(db, {
      key: KEY,
      onLegacyRead: () => {
        legacyReads++;
      },
    });

    // First read fires the legacy callback and returns plaintext.
    const before = repo.getSecret(hh, "legacy");
    expect(before!.credential["access_token"]).toBe("legacy-at");
    expect(legacyReads).toBe(1);

    // Migrate: legacy row becomes encrypted; already-encrypted
    // rows are skipped (upgraded count doesn't include them).
    const beforeCount = repo.migrateLegacyRows();
    expect(beforeCount.upgraded).toBeGreaterThanOrEqual(1);

    // Row on disk is now ciphertext.
    const row = db
      .select()
      .from(credentialsTable)
      .where(eq(credentialsTable.id, "crd_legacy_1"))
      .get();
    expect(isEncryptedCredential(row!.credential)).toBe(true);

    // Subsequent read decrypts cleanly, doesn't fire the legacy
    // callback again.
    legacyReads = 0;
    const after = repo.getSecret(hh, "legacy");
    expect(after!.credential["access_token"]).toBe("legacy-at");
    expect(legacyReads).toBe(0);

    // Second migrate is a no-op — nothing new to upgrade.
    const secondPass = repo.migrateLegacyRows();
    expect(secondPass.upgraded).toBe(0);
  });
});
