import { randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { nowIso, type HouseholdId } from "@atelier/domain";
import type { Db } from "../client.js";
import { credentials, type CredentialRow } from "../schema/credentials.js";
import {
  decryptCredential,
  encryptCredential,
  isEncryptedCredential,
  parseMasterKey,
} from "../credential-crypto.js";

const newCredentialId = (): string => `crd_${randomBytes(12).toString("hex")}`;

export interface StoreCredentialInput {
  readonly householdId: HouseholdId;
  readonly provider: string;
  readonly kind: "oauth2" | "api_key" | "token" | "other";
  readonly label: string;
  readonly principalRef?: string;
  readonly credential: Record<string, unknown>;
  readonly scopes?: readonly string[];
  readonly expiresAt?: string;
}

export interface CredentialSummary {
  readonly id: string;
  readonly provider: string;
  readonly kind: string;
  readonly label: string;
  readonly principalRef: string | null;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly lastUsedAt: string | null;
}

const toSummary = (r: CredentialRow): CredentialSummary => ({
  id: r.id,
  provider: r.provider,
  kind: r.kind,
  label: r.label,
  principalRef: r.principalRef,
  scopes: (r.scopes ?? []) as string[],
  createdAt: r.createdAt,
  expiresAt: r.expiresAt,
  revokedAt: r.revokedAt,
  lastUsedAt: r.lastUsedAt,
});

export interface CredentialRepoOptions {
  /**
   * Explicit master key (32 bytes). When omitted, the repo reads
   * ATELIER_CREDENTIAL_KEY from the env. Tests can inject a key
   * to avoid a real env setup.
   */
  readonly key?: Buffer;
  /**
   * Optional callback fired the first time a legacy plaintext row
   * is read. Tests can assert on this; production wires it to the
   * logger.
   */
  readonly onLegacyRead?: (id: string) => void;
}

// Read the stored credential blob and return the plaintext dict.
// Handles three cases:
//   - encrypted v1 (the new normal): decrypt with the master key.
//   - legacy plaintext (pre-encryption era): return as-is and
//     fire onLegacyRead so the caller knows to encourage a
//     re-write. Rows upgrade transparently the next time
//     updateAccessToken (or a future rotate helper) touches them.
//   - anything else: throw — either the DB has been tampered with
//     or the master key is wrong.
const unwrap = (
  key: Buffer,
  stored: unknown,
  rowId: string,
  onLegacyRead?: (id: string) => void,
): Record<string, unknown> => {
  if (isEncryptedCredential(stored)) {
    return decryptCredential(key, stored);
  }
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    onLegacyRead?.(rowId);
    return stored as Record<string, unknown>;
  }
  throw new Error(
    `credential row ${rowId} has an unrecognized shape — either tampered or the master key is wrong`,
  );
};

export const credentialRepo = (db: Db, opts: CredentialRepoOptions = {}) => {
  // Resolve the master key eagerly so a misconfigured deploy fails
  // at boot rather than at first credential read. The env-read
  // path here matches every other repo's "read config at
  // construction time" pattern.
  const key = opts.key ?? parseMasterKey(process.env["ATELIER_CREDENTIAL_KEY"]);
  const onLegacyRead = opts.onLegacyRead;

  return {
    store(input: StoreCredentialInput): CredentialSummary {
      const id = newCredentialId();
      const encrypted = encryptCredential(key, input.credential);
      db.insert(credentials)
        .values({
          id,
          householdId: input.householdId,
          provider: input.provider,
          kind: input.kind,
          label: input.label,
          principalRef: input.principalRef ?? null,
          credential: encrypted,
          scopes: input.scopes ?? [],
          createdAt: nowIso(),
          expiresAt: input.expiresAt ?? null,
        })
        .run();
      const row = db.select().from(credentials).where(eq(credentials.id, id)).get();
      if (!row) throw new Error("credential insert did not return");
      return toSummary(row);
    },

    list(householdId: HouseholdId): CredentialSummary[] {
      return db
        .select()
        .from(credentials)
        .where(eq(credentials.householdId, householdId))
        .orderBy(desc(credentials.createdAt))
        .all()
        .map(toSummary);
    },

    // Get the *raw* credential dict, decrypting if it's stored in
    // the encrypted envelope. Callers should be tool adapters
    // (Google, Twilio, etc.) — never a route that returns the value
    // to a browser.
    getSecret(householdId: HouseholdId, provider: string): {
      id: string;
      credential: Record<string, unknown>;
      expiresAt: string | null;
    } | null {
      const row = db
        .select()
        .from(credentials)
        .where(
          and(
            eq(credentials.householdId, householdId),
            eq(credentials.provider, provider),
            isNull(credentials.revokedAt),
          ),
        )
        .orderBy(desc(credentials.createdAt))
        .get();
      if (!row) return null;
      return {
        id: row.id,
        credential: unwrap(key, row.credential, row.id, onLegacyRead),
        expiresAt: row.expiresAt,
      };
    },

    updateAccessToken(id: string, accessToken: string, expiresAt: string): void {
      const row = db.select().from(credentials).where(eq(credentials.id, id)).get();
      if (!row) return;
      const current = unwrap(key, row.credential, row.id, onLegacyRead);
      const merged = { ...current, access_token: accessToken };
      const encrypted = encryptCredential(key, merged);
      db.update(credentials)
        .set({ credential: encrypted, expiresAt, lastUsedAt: nowIso() })
        .where(eq(credentials.id, id))
        .run();
    },

    markUsed(id: string): void {
      db.update(credentials)
        .set({ lastUsedAt: nowIso() })
        .where(eq(credentials.id, id))
        .run();
    },

    revoke(id: string): void {
      db.update(credentials)
        .set({ revokedAt: nowIso() })
        .where(eq(credentials.id, id))
        .run();
    },

    // Bulk re-encrypt every legacy plaintext row. Idempotent —
    // already-encrypted rows are skipped. Returns a count so the
    // caller can log or expose a health check.
    migrateLegacyRows(): { scanned: number; upgraded: number } {
      const rows = db.select().from(credentials).all();
      let upgraded = 0;
      for (const row of rows) {
        if (isEncryptedCredential(row.credential)) continue;
        if (!row.credential || typeof row.credential !== "object") continue;
        const encrypted = encryptCredential(
          key,
          row.credential as Record<string, unknown>,
        );
        db.update(credentials)
          .set({ credential: encrypted })
          .where(eq(credentials.id, row.id))
          .run();
        upgraded++;
      }
      return { scanned: rows.length, upgraded };
    },
  };
};
