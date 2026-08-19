import { randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { nowIso, type HouseholdId } from "@atelier/domain";
import type { Db } from "../client.js";
import { credentials, type CredentialRow } from "../schema/credentials.js";

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

export const credentialRepo = (db: Db) => ({
  store(input: StoreCredentialInput): CredentialSummary {
    const id = newCredentialId();
    db.insert(credentials)
      .values({
        id,
        householdId: input.householdId,
        provider: input.provider,
        kind: input.kind,
        label: input.label,
        principalRef: input.principalRef ?? null,
        credential: input.credential,
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

  // Get the *raw* credential blob. Should be gated behind an audited
  // caller in production; here it's for internal adapter use only.
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
      credential: (row.credential ?? {}) as Record<string, unknown>,
      expiresAt: row.expiresAt,
    };
  },

  updateAccessToken(id: string, accessToken: string, expiresAt: string): void {
    const row = db.select().from(credentials).where(eq(credentials.id, id)).get();
    if (!row) return;
    const merged = {
      ...((row.credential ?? {}) as Record<string, unknown>),
      access_token: accessToken,
    };
    db.update(credentials)
      .set({ credential: merged, expiresAt, lastUsedAt: nowIso() })
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
});
