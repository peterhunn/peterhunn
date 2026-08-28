import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  openDb,
  auditChainRepo,
  auditRepo,
  auditEvents,
  HOUSEHOLD_CHAIN_KEY,
  householdRepo,
  identityRepo,
} from "@atelier/db";
import { eq } from "drizzle-orm";
import type { HouseholdId } from "@atelier/domain";
import { buildServer } from "../src/server.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let db: ReturnType<typeof openDb>;
let token: string;
let hh: HouseholdId;
let hhOther: HouseholdId;
const alexId = "prn_alex_chain";
const bobId = "prn_bob_chain";

beforeAll(async () => {
  db = openDb({ url: ":memory:" });
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: "../../packages/db/migrations" });

  const identity = identityRepo(db);
  const m = identity.createManager({
    displayName: "Manager Alex",
    email: "m@a.b",
  });
  token = identity.mintToken({
    actorType: "manager",
    actorId: m.id,
    label: "t",
  }).token;
  const households = householdRepo(db);
  hh = households.create({ name: "A", tier: "life" }).id;
  hhOther = households.create({ name: "B", tier: "life" }).id;
  identity.grantHousehold({ managerId: m.id, householdId: hh, role: "primary" });
  identity.grantHousehold({
    managerId: m.id,
    householdId: hhOther,
    role: "primary",
  });

  app = buildServer(db);
  await app.ready();
});

afterAll(async () => await app.close());

describe("audit Merkle DAG — household + person chains", () => {
  it("appends every audit event onto the household chain and inferred person chains", async () => {
    const audit = auditRepo(db);
    const chain = auditChainRepo(db);

    // Event 1: household-only (no principal reference).
    audit.record({
      householdId: hh,
      actor: { type: "manager", id: "mgr_alex", displayName: "Alex" },
      action: "household.settings.read",
      resourceType: "household",
      resourceId: hh,
    });
    // Event 2: person-scoped (resource_type "principal") — feeds
    // both the household chain and Alex's person chain.
    audit.record({
      householdId: hh,
      actor: { type: "manager", id: "mgr_alex", displayName: "Alex" },
      action: "principal.read",
      resourceType: "principal",
      resourceId: alexId,
    });
    // Event 3: explicit principalIds via input (Bob).
    audit.record({
      householdId: hh,
      actor: { type: "manager", id: "mgr_alex", displayName: "Alex" },
      action: "documents.list",
      resourceType: "document",
      resourceId: "nod_doc_1",
      principalIds: [bobId],
    });
    // Event 4: touches both Alex and Bob via metadata.route.
    audit.record({
      householdId: hh,
      actor: { type: "manager", id: "mgr_alex", displayName: "Alex" },
      action: "approval.approve",
      resourceType: "approval",
      resourceId: "apr_1",
      metadata: {
        route: { principalIds: [alexId, bobId] },
      },
    });

    // Household head advanced 4 events; sequence == 4.
    const householdHead = chain.getHead(hh, HOUSEHOLD_CHAIN_KEY);
    expect(householdHead).not.toBeNull();
    expect(householdHead!.eventCount).toBe(4);

    // Alex's chain: event 2 + event 4 = 2 events.
    const alexHead = chain.getHead(hh, alexId);
    expect(alexHead?.eventCount).toBe(2);
    // Bob's chain: event 3 + event 4 = 2 events.
    const bobHead = chain.getHead(hh, bobId);
    expect(bobHead?.eventCount).toBe(2);

    // Household head hash matches the last event's hash — the two
    // are the same value, just different lookups.
    expect(householdHead!.headHash).toBe(alexHead!.headHash);
    expect(householdHead!.headHash).toBe(bobHead!.headHash);
    // (Because event 4 was the last append and touched both
    // person chains + the household chain.)

    // Different households have independent chains — recording an
    // event on hhOther doesn't touch hh's heads.
    const hhHeadBefore = householdHead!.headHash;
    audit.record({
      householdId: hhOther,
      actor: { type: "manager", id: "mgr_alex", displayName: "Alex" },
      action: "household.settings.read",
      resourceType: "household",
      resourceId: hhOther,
    });
    const hhHeadAfter = chain.getHead(hh, HOUSEHOLD_CHAIN_KEY);
    expect(hhHeadAfter!.headHash).toBe(hhHeadBefore);
    expect(chain.getHead(hhOther, HOUSEHOLD_CHAIN_KEY)?.eventCount).toBe(1);
  });

  it("verifies the household chain end-to-end and returns valid: true", async () => {
    const chain = auditChainRepo(db);
    const result = chain.verifyHouseholdChain(hh);
    expect(result.valid).toBe(true);
    expect(result.eventCount).toBe(4);
    expect(result.headHash).toBe(chain.getHead(hh, HOUSEHOLD_CHAIN_KEY)?.headHash);
  });

  it("verifies each person chain independently", async () => {
    const chain = auditChainRepo(db);
    const alex = chain.verifyPersonChain(hh, alexId);
    const bob = chain.verifyPersonChain(hh, bobId);
    expect(alex.valid).toBe(true);
    expect(alex.eventCount).toBe(2);
    expect(bob.valid).toBe(true);
    expect(bob.eventCount).toBe(2);
    // Empty chain for a principal with no events — valid, count 0.
    const stranger = chain.verifyPersonChain(hh, "prn_stranger");
    expect(stranger.valid).toBe(true);
    expect(stranger.eventCount).toBe(0);
  });

  it("detects tampering — mutating an audit_events row on the chain breaks verification at that event", async () => {
    // Find the event on Alex's chain (event 2: principal.read on alexId).
    const targetRow = db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "principal.read"))
      .get();
    expect(targetRow).toBeDefined();

    // Rewrite the action field silently — an attacker with DB
    // write access modifies the record. The audit_event_hashes
    // row is untouched, but the stored hash was computed over
    // the OLD content, so re-hashing at verification time yields
    // a different value → mismatch.
    db.update(auditEvents)
      .set({ action: "principal.tampered" })
      .where(eq(auditEvents.id, targetRow!.id))
      .run();

    const chain = auditChainRepo(db);
    const result = chain.verifyHouseholdChain(hh);
    expect(result.valid).toBe(false);
    expect(result.brokenAtEventId).toBe(targetRow!.id);
    expect(result.brokenReason).toBe("hash_mismatch");

    // Alex's chain also breaks at the same event — the tamper
    // shows in both places because both chains include that
    // event's hash.
    const alexResult = chain.verifyPersonChain(hh, alexId);
    expect(alexResult.valid).toBe(false);
    expect(alexResult.brokenAtEventId).toBe(targetRow!.id);

    // Bob's chain doesn't include the tampered event, so it
    // still verifies clean — this is the point of per-person
    // chains: a tamper on one customer's slice doesn't taint
    // another's.
    const bobResult = chain.verifyPersonChain(hh, bobId);
    expect(bobResult.valid).toBe(true);

    // Restore the row so downstream tests aren't affected.
    db.update(auditEvents)
      .set({ action: "principal.read" })
      .where(eq(auditEvents.id, targetRow!.id))
      .run();
    expect(chain.verifyHouseholdChain(hh).valid).toBe(true);
  });

  it("backfill is idempotent — running it after events are already hashed processes 0", async () => {
    const chain = auditChainRepo(db);
    const { processed } = chain.backfill();
    expect(processed).toBe(0);
  });

  it("HTTP endpoints expose head + verify for both chain scopes", async () => {
    const head = await app.inject({
      method: "GET",
      url: `/households/${hh}/audit/chain/head`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(head.statusCode).toBe(200);
    const headBody = head.json();
    expect(headBody.chain).toBe("household");
    expect(headBody.head.eventCount).toBeGreaterThan(0);
    expect(headBody.head.headHash).toMatch(/^[0-9a-f]{64}$/);

    const verify = await app.inject({
      method: "GET",
      url: `/households/${hh}/audit/chain/verify`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().result.valid).toBe(true);

    const personHead = await app.inject({
      method: "GET",
      url: `/households/${hh}/audit/chain/person/${alexId}/head`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(personHead.json().head.eventCount).toBe(2);

    const personVerify = await app.inject({
      method: "GET",
      url: `/households/${hh}/audit/chain/person/${alexId}/verify`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(personVerify.json().result.valid).toBe(true);
  });
});
