import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  newManagerId,
  nowIso,
  type Actor,
  type ActorType,
  type HouseholdId,
  type HouseholdGrantRole,
  type Manager,
  type ManagerId,
} from "@atelier/domain";
import type { Db } from "../client.js";
import { managers, apiTokens, householdGrants } from "../schema/identity.js";

// Tokens are stored hashed. Only the plaintext is returned at mint
// time; from then on the API sees only the hash. Every mint now
// carries an expiry — the default is 90 days, tunable per mint via
// ttlSeconds or a caller-set expiresAt.
//
// resolveToken returns a discriminated union so the auth plugin
// can distinguish "unknown token" from "expired" from "revoked" —
// clients can then decide whether to re-auth or retry.

const DEFAULT_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

const toManager = (r: typeof managers.$inferSelect): Manager => ({
  id: r.id as ManagerId,
  displayName: r.displayName,
  email: r.email,
  createdAt: r.createdAt,
  archivedAt: r.archivedAt ?? undefined,
});

export interface CreateManagerInput {
  readonly displayName: string;
  readonly email: string;
}

export interface MintTokenInput {
  readonly actorType: ActorType;
  readonly actorId: string;
  readonly label: string;
  /**
   * ISO datetime the token expires at. Takes precedence over
   * ttlSeconds when both supplied. Pass null explicitly to opt
   * out of expiry — kept for the seed script; the API surface
   * should never do this.
   */
  readonly expiresAt?: string | null;
  /**
   * TTL in seconds relative to now. Defaults to 90 days when
   * neither expiresAt nor ttlSeconds is given.
   */
  readonly ttlSeconds?: number;
}

export interface TokenSummary {
  readonly id: string;
  readonly label: string;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

export type TokenResolution =
  | { readonly ok: true; readonly actor: Actor; readonly tokenId: string }
  | { readonly ok: false; readonly reason: "invalid" | "expired" | "revoked" };

export interface GrantHouseholdInput {
  readonly managerId: ManagerId;
  readonly householdId: HouseholdId;
  readonly role: HouseholdGrantRole;
}

const computeExpiry = (input: MintTokenInput): string | null => {
  if (input.expiresAt === null) return null; // explicit opt-out
  if (input.expiresAt) return input.expiresAt;
  const seconds = input.ttlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS;
  return new Date(Date.now() + seconds * 1000).toISOString();
};

export const identityRepo = (db: Db) => {
  const mintInternal = (
    input: MintTokenInput,
  ): { token: string; tokenId: string; expiresAt: string | null } => {
    const raw = `atl_${randomBytes(24).toString("base64url")}`;
    const tokenId = `tok_${randomBytes(8).toString("hex")}`;
    const expiresAt = computeExpiry(input);
    db.insert(apiTokens)
      .values({
        id: tokenId,
        tokenHash: hashToken(raw),
        actorType: input.actorType,
        actorId: input.actorId,
        label: input.label,
        createdAt: nowIso(),
        expiresAt,
      })
      .run();
    return { token: raw, tokenId, expiresAt };
  };

  const buildActor = (row: typeof apiTokens.$inferSelect): Actor | null => {
    if (row.actorType === "manager") {
      const m = db
        .select()
        .from(managers)
        .where(eq(managers.id, row.actorId))
        .get();
      if (!m || m.archivedAt !== null) return null;
      const grants = db
        .select()
        .from(householdGrants)
        .where(
          and(
            eq(householdGrants.managerId, row.actorId),
            isNull(householdGrants.revokedAt),
          ),
        )
        .all();
      return {
        type: "manager",
        id: m.id,
        displayName: m.displayName,
        householdIds: grants.map((g) => g.householdId as HouseholdId),
      };
    }
    return {
      type: row.actorType as ActorType,
      id: row.actorId,
      displayName: row.actorId,
      householdIds: [],
    };
  };

  return {
    createManager(input: CreateManagerInput): Manager {
      const row = {
        id: newManagerId(),
        displayName: input.displayName,
        email: input.email,
        createdAt: nowIso(),
      } satisfies typeof managers.$inferInsert;
      db.insert(managers).values(row).run();
      return toManager(row);
    },

    getManagerByEmail(email: string): Manager | null {
      const row = db
        .select()
        .from(managers)
        .where(and(eq(managers.email, email), isNull(managers.archivedAt)))
        .get();
      return row ? toManager(row) : null;
    },

    mintToken(input: MintTokenInput): {
      token: string;
      tokenId: string;
      expiresAt: string | null;
    } {
      return mintInternal(input);
    },

    // Rotate: mint a new token inheriting the old one's actor +
    // label + TTL semantics (fresh 90d from now unless overridden),
    // then revoke the old one. Returns the new token; caller shows
    // it once and never again.
    rotateToken(
      oldTokenId: string,
      opts: { ttlSeconds?: number } = {},
    ): { token: string; tokenId: string; expiresAt: string | null } | null {
      const old = db
        .select()
        .from(apiTokens)
        .where(eq(apiTokens.id, oldTokenId))
        .get();
      if (!old) return null;
      const fresh = mintInternal({
        actorType: old.actorType,
        actorId: old.actorId,
        label: old.label,
        ...(opts.ttlSeconds !== undefined ? { ttlSeconds: opts.ttlSeconds } : {}),
      });
      db.update(apiTokens)
        .set({ revokedAt: nowIso() })
        .where(eq(apiTokens.id, oldTokenId))
        .run();
      return fresh;
    },

    revokeToken(tokenId: string): boolean {
      const res = db
        .update(apiTokens)
        .set({ revokedAt: nowIso() })
        .where(eq(apiTokens.id, tokenId))
        .run();
      // better-sqlite3's run() returns changes as .changes; treat
      // "we tried to revoke and something happened" as success.
      return (res as unknown as { changes: number }).changes > 0;
    },

    listTokens(actorType: ActorType, actorId: string): TokenSummary[] {
      return db
        .select()
        .from(apiTokens)
        .where(
          and(
            eq(apiTokens.actorType, actorType),
            eq(apiTokens.actorId, actorId),
          ),
        )
        .orderBy(desc(apiTokens.createdAt))
        .all()
        .map((r) => ({
          id: r.id,
          label: r.label,
          createdAt: r.createdAt,
          expiresAt: r.expiresAt,
          lastUsedAt: r.lastUsedAt,
          revokedAt: r.revokedAt,
        }));
    },

    // Resolve with a discriminated union so the auth plugin can
    // 401 with a specific reason. Callers that don't care about
    // the distinction can use `resolveActor` — kept for back-compat.
    resolveToken(token: string): TokenResolution {
      const row = db
        .select()
        .from(apiTokens)
        .where(eq(apiTokens.tokenHash, hashToken(token)))
        .get();
      if (!row) return { ok: false, reason: "invalid" };
      if (row.revokedAt !== null) return { ok: false, reason: "revoked" };
      if (row.expiresAt !== null && row.expiresAt < nowIso()) {
        return { ok: false, reason: "expired" };
      }
      const actor = buildActor(row);
      if (!actor) return { ok: false, reason: "invalid" };
      db.update(apiTokens)
        .set({ lastUsedAt: nowIso() })
        .where(eq(apiTokens.id, row.id))
        .run();
      return { ok: true, actor, tokenId: row.id };
    },

    // Back-compat: returns just the actor or null. Prefer
    // resolveToken above in new code.
    resolveActor(token: string): Actor | null {
      const r = this.resolveToken(token);
      return r.ok ? r.actor : null;
    },

    grantHousehold(input: GrantHouseholdInput): void {
      db.insert(householdGrants)
        .values({
          managerId: input.managerId,
          householdId: input.householdId,
          role: input.role,
          grantedAt: nowIso(),
        })
        .onConflictDoNothing()
        .run();
    },

    revokeHousehold(managerId: ManagerId, householdId: HouseholdId): void {
      db.update(householdGrants)
        .set({ revokedAt: nowIso() })
        .where(
          and(
            eq(householdGrants.managerId, managerId),
            eq(householdGrants.householdId, householdId),
          ),
        )
        .run();
    },
  };
};
