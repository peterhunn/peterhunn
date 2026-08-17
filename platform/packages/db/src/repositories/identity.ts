import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
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

// Tokens are stored hashed. Only the plaintext is returned to the caller
// at mint time; from then on the API sees only the hash. This is Phase-0
// bearer-token infrastructure — passkeys + SSO replace it later.
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
  readonly expiresAt?: string;
}

export interface GrantHouseholdInput {
  readonly managerId: ManagerId;
  readonly householdId: HouseholdId;
  readonly role: HouseholdGrantRole;
}

export const identityRepo = (db: Db) => ({
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

  mintToken(input: MintTokenInput): { token: string; tokenId: string } {
    const raw = `atl_${randomBytes(24).toString("base64url")}`;
    const tokenId = `tok_${randomBytes(8).toString("hex")}`;
    db.insert(apiTokens)
      .values({
        id: tokenId,
        tokenHash: hashToken(raw),
        actorType: input.actorType,
        actorId: input.actorId,
        label: input.label,
        createdAt: nowIso(),
        expiresAt: input.expiresAt ?? null,
      })
      .run();
    return { token: raw, tokenId };
  },

  resolveActor(token: string): Actor | null {
    const row = db
      .select()
      .from(apiTokens)
      .where(and(eq(apiTokens.tokenHash, hashToken(token)), isNull(apiTokens.revokedAt)))
      .get();
    if (!row) return null;
    if (row.expiresAt !== null && row.expiresAt < nowIso()) return null;

    db.update(apiTokens)
      .set({ lastUsedAt: nowIso() })
      .where(eq(apiTokens.id, row.id))
      .run();

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
});
