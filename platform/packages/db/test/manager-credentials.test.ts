import { describe, it, expect, beforeEach } from "vitest";
import {
  openDb,
  identityRepo,
  managerCredentialRepo,
  webauthnChallengeRepo,
} from "../src/index.js";
import type { ManagerId } from "@atelier/domain";

let db: ReturnType<typeof openDb>;
let mgrId: ManagerId;

beforeEach(async () => {
  db = openDb({ url: ":memory:" });
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: "./migrations" });
  const m = identityRepo(db).createManager({ displayName: "M", email: "m@a.b" });
  mgrId = m.id;
});

describe("managerCredentialRepo", () => {
  it("stores, lists, and deletes a credential — scoped to the owning manager", () => {
    const repo = managerCredentialRepo(db);
    const other = identityRepo(db).createManager({ displayName: "O", email: "o@a.b" });

    const { id } = repo.store({
      managerId: mgrId,
      credentialId: "cred-abc",
      publicKey: "pk-b64",
      counter: 0,
      transports: ["internal"],
      deviceLabel: "MacBook",
    });

    expect(repo.list(mgrId)).toHaveLength(1);
    expect(repo.list(other.id)).toHaveLength(0);

    // Cross-owner delete is a no-op — nobody can nuke another
    // manager's passkeys just by knowing the id.
    expect(repo.deleteById(id, other.id).deleted).toBe(false);
    expect(repo.list(mgrId)).toHaveLength(1);

    expect(repo.deleteById(id, mgrId).deleted).toBe(true);
    expect(repo.list(mgrId)).toHaveLength(0);
  });

  it("looks up by the raw credentialId", () => {
    const repo = managerCredentialRepo(db);
    repo.store({
      managerId: mgrId,
      credentialId: "cred-xyz",
      publicKey: "pk",
      counter: 0,
      deviceLabel: "YubiKey",
    });
    const found = repo.findByCredentialId("cred-xyz");
    expect(found?.managerId).toBe(mgrId);
    expect(repo.findByCredentialId("nope")).toBeNull();
  });

  it("updateCounter monotonically increases and stamps lastUsedAt", () => {
    const repo = managerCredentialRepo(db);
    const { id } = repo.store({
      managerId: mgrId,
      credentialId: "cred-1",
      publicKey: "pk",
      counter: 0,
      deviceLabel: "Phone",
    });
    const before = repo.list(mgrId)[0]!;
    expect(before.lastUsedAt).toBeNull();

    repo.updateCounter(id, 42);
    const after = repo.list(mgrId)[0]!;
    expect(after.counter).toBe(42);
    expect(after.lastUsedAt).not.toBeNull();
  });
});

describe("webauthnChallengeRepo", () => {
  it("issues a challenge, consumes it once, and refuses replay", () => {
    const repo = webauthnChallengeRepo(db);
    const { id } = repo.create({
      subject: mgrId,
      ceremony: "register",
      challenge: "chal-abc",
    });
    const first = repo.consume(id);
    expect(first.ok).toBe(true);
    expect(first.challenge).toBe("chal-abc");
    expect(first.subject).toBe(mgrId);
    expect(first.ceremony).toBe("register");

    const second = repo.consume(id);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("not_found");
  });

  it("reports expired challenges as such (still deletes the row)", async () => {
    // Bypass the TTL by hand-inserting a row that expires immediately.
    const repo = webauthnChallengeRepo(db);
    const { id } = repo.create({
      subject: mgrId,
      ceremony: "login",
      challenge: "chal-old",
    });
    // Waltz past the row's expiry by simulating time — the repo's
    // check is "expiresAt < now" so overwrite via raw SQL.
    const { webauthnChallenges } = await import(
      "../src/schema/manager_credentials.js"
    );
    const { eq } = await import("drizzle-orm");
    db.update(webauthnChallenges)
      .set({ expiresAt: "1990-01-01T00:00:00.000Z" })
      .where(eq(webauthnChallenges.id, id))
      .run();
    const res = repo.consume(id);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("expired");
  });

  it("sweeps expired rows on create — table stays bounded", async () => {
    const repo = webauthnChallengeRepo(db);
    // Pre-plant an expired row.
    const stale = repo.create({
      subject: mgrId,
      ceremony: "register",
      challenge: "old",
    });
    const { webauthnChallenges } = await import(
      "../src/schema/manager_credentials.js"
    );
    const { eq } = await import("drizzle-orm");
    db.update(webauthnChallenges)
      .set({ expiresAt: "1990-01-01T00:00:00.000Z" })
      .where(eq(webauthnChallenges.id, stale.id))
      .run();

    // Issuing a fresh one triggers the sweep.
    repo.create({ subject: mgrId, ceremony: "login", challenge: "new" });

    const remaining = db.select().from(webauthnChallenges).all();
    // Only the fresh row survives.
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.challenge).toBe("new");
  });
});
