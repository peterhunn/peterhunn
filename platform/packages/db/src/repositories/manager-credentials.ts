import { randomBytes } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { nowIso, type ManagerId } from "@atelier/domain";
import type { Db } from "../client.js";
import {
  managerCredentials,
  webauthnChallenges,
  type ManagerCredentialRow,
} from "../schema/manager_credentials.js";

// Short — a passkey ceremony completes in seconds. Long enough
// for a slow user to hit "Continue" but short enough that stale
// challenges self-clean before the next tick.
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

const newCredId = (): string => `mcr_${randomBytes(12).toString("hex")}`;
const newChallengeId = (): string => `wac_${randomBytes(12).toString("hex")}`;

export interface StoreManagerCredentialInput {
  readonly managerId: ManagerId;
  readonly credentialId: string;
  readonly publicKey: string;
  readonly counter: number;
  readonly transports?: readonly string[];
  readonly deviceLabel: string;
}

export interface CreateChallengeInput {
  readonly subject: string;
  readonly ceremony: "register" | "login";
  readonly challenge: string;
}

export const managerCredentialRepo = (db: Db) => ({
  list(managerId: ManagerId): ManagerCredentialRow[] {
    return db
      .select()
      .from(managerCredentials)
      .where(eq(managerCredentials.managerId, managerId))
      .all();
  },

  findByCredentialId(credentialId: string): ManagerCredentialRow | null {
    return (
      db
        .select()
        .from(managerCredentials)
        .where(eq(managerCredentials.credentialId, credentialId))
        .get() ?? null
    );
  },

  store(input: StoreManagerCredentialInput): { id: string } {
    const id = newCredId();
    db.insert(managerCredentials)
      .values({
        id,
        managerId: input.managerId,
        credentialId: input.credentialId,
        publicKey: input.publicKey,
        counter: input.counter,
        transports: input.transports ?? [],
        deviceLabel: input.deviceLabel,
        createdAt: nowIso(),
        lastUsedAt: null,
      })
      .run();
    return { id };
  },

  updateCounter(id: string, counter: number): void {
    db.update(managerCredentials)
      .set({ counter, lastUsedAt: nowIso() })
      .where(eq(managerCredentials.id, id))
      .run();
  },

  deleteById(id: string, managerId: ManagerId): { deleted: boolean } {
    const res = db
      .delete(managerCredentials)
      .where(
        and(
          eq(managerCredentials.id, id),
          eq(managerCredentials.managerId, managerId),
        ),
      )
      .run();
    return { deleted: (res.changes ?? 0) > 0 };
  },
});

export const webauthnChallengeRepo = (db: Db) => ({
  create(input: CreateChallengeInput): { id: string; expiresAt: string } {
    // Cheap sweep of expired rows every time a new one is issued.
    // Keeps the table bounded without a separate cleanup timer.
    db.delete(webauthnChallenges)
      .where(lt(webauthnChallenges.expiresAt, nowIso()))
      .run();

    const id = newChallengeId();
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
    db.insert(webauthnChallenges)
      .values({
        id,
        subject: input.subject,
        ceremony: input.ceremony,
        challenge: input.challenge,
        createdAt: nowIso(),
        expiresAt,
      })
      .run();
    return { id, expiresAt };
  },

  consume(id: string): {
    ok: boolean;
    subject?: string;
    ceremony?: "register" | "login";
    challenge?: string;
    reason?: "not_found" | "expired";
  } {
    const row = db
      .select()
      .from(webauthnChallenges)
      .where(eq(webauthnChallenges.id, id))
      .get();
    if (!row) return { ok: false, reason: "not_found" };
    // Delete regardless — single use.
    db.delete(webauthnChallenges)
      .where(eq(webauthnChallenges.id, id))
      .run();
    if (row.expiresAt < nowIso()) return { ok: false, reason: "expired" };
    return {
      ok: true,
      subject: row.subject,
      ceremony: row.ceremony,
      challenge: row.challenge,
    };
  },
});
