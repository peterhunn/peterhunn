import { describe, it, expect, beforeEach } from "vitest";
import {
  openDb,
  contactEndpointRepo,
  conversationSessionRepo,
  householdRepo,
  messagingEventRepo,
  CONVERSATION_IDLE_MS,
} from "../src/index.js";
import type { HouseholdId } from "@atelier/domain";

let db: ReturnType<typeof openDb>;
let hh: HouseholdId;
let epId: string;

beforeEach(async () => {
  db = openDb({ url: ":memory:" });
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: "./migrations" });
  hh = householdRepo(db).create({ name: "SessionH", tier: "life" }).id;
  epId = contactEndpointRepo(db).create({
    householdId: hh,
    channel: "sms",
    address: "+14158675200",
  }).id;
});

describe("conversationSessionRepo", () => {
  it("openOrResume creates a fresh session on first call, resumes on subsequent calls within window", () => {
    const repo = conversationSessionRepo(db);
    const first = repo.openOrResume({ householdId: hh, endpointId: epId });
    expect(first.resumed).toBe(false);
    expect(first.session.id).toMatch(/^ses_/);

    const second = repo.openOrResume({ householdId: hh, endpointId: epId });
    expect(second.resumed).toBe(true);
    expect(second.session.id).toBe(first.session.id);
    // lastActivityAt bumped forward on resume.
    expect(new Date(second.session.lastActivityAt).getTime()).toBeGreaterThanOrEqual(
      new Date(first.session.lastActivityAt).getTime(),
    );
  });

  it("opens a NEW session when the previous one exceeded the idle window", () => {
    const repo = conversationSessionRepo(db);
    const t0 = Date.now();
    const first = repo.openOrResume({
      householdId: hh,
      endpointId: epId,
      nowMs: t0,
    });
    // Simulate 31 minutes later.
    const later = t0 + CONVERSATION_IDLE_MS + 60_000;
    const second = repo.openOrResume({
      householdId: hh,
      endpointId: epId,
      nowMs: later,
    });
    expect(second.resumed).toBe(false);
    expect(second.session.id).not.toBe(first.session.id);
  });

  it("close() prevents resume — a subsequent openOrResume opens a fresh session", () => {
    const repo = conversationSessionRepo(db);
    const first = repo.openOrResume({ householdId: hh, endpointId: epId });
    repo.close(first.session.id);
    const next = repo.openOrResume({ householdId: hh, endpointId: epId });
    expect(next.resumed).toBe(false);
    expect(next.session.id).not.toBe(first.session.id);
  });

  it("listBySession returns events oldest-first for reconstruction", () => {
    const sessionRepo = conversationSessionRepo(db);
    const events = messagingEventRepo(db);
    const { session } = sessionRepo.openOrResume({
      householdId: hh,
      endpointId: epId,
    });
    for (let i = 0; i < 3; i++) {
      events.record({
        householdId: hh,
        channel: "sms",
        direction: i % 2 === 0 ? "inbound" : "outbound",
        provider: "mock",
        fromAddress: i % 2 === 0 ? "+14158675200" : "+15555550100",
        toAddress: i % 2 === 0 ? "+15555550100" : "+14158675200",
        body: `turn ${i}`,
        externalMessageId: `mock_seq_${i}`,
        sessionId: session.id,
      });
    }
    const turns = events.listBySession(session.id);
    expect(turns).toHaveLength(3);
    expect(turns.map((t) => t.body)).toEqual(["turn 0", "turn 1", "turn 2"]);
  });
});
