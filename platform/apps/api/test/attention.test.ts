import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  openDb,
  contactEndpointRepo,
  graphRepo,
  householdRepo,
  identityRepo,
  messagingEventRepo,
} from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";
import { buildServer } from "../src/server.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let token: string;
let hhA: HouseholdId;
let hhB: HouseholdId;
let hhC: HouseholdId;

const iso = (offsetMs: number): string =>
  new Date(Date.now() + offsetMs).toISOString();

beforeAll(async () => {
  const db = openDb({ url: ":memory:" });
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: "../../packages/db/migrations" });

  const identity = identityRepo(db);
  const households = householdRepo(db);
  const endpoints = contactEndpointRepo(db);
  const events = messagingEventRepo(db);
  const graph = graphRepo(db);

  const m = identity.createManager({
    displayName: "Attention Manager",
    email: "attn@a.b",
  });
  token = identity.mintToken({
    actorType: "manager",
    actorId: m.id,
    label: "t",
  }).token;

  // Household A — unread inbound + delivery failure + upcoming
  // obligation. Household B — frozen. Household C — not granted
  // to this manager, must not appear.
  const a = households.create({ name: "House A", tier: "life" });
  hhA = a.id;
  const b = households.create({ name: "House B", tier: "life" });
  hhB = b.id;
  const c = households.create({ name: "House C", tier: "life" });
  hhC = c.id;

  identity.grantHousehold({
    managerId: m.id,
    householdId: hhA,
    role: "primary",
  });
  identity.grantHousehold({
    managerId: m.id,
    householdId: hhB,
    role: "primary",
  });
  // hhC deliberately NOT granted.

  households.freeze(hhB, "manual pause");

  // Endpoint + inbound event that has no reply (unread).
  const epUnread = endpoints.create({
    householdId: hhA,
    channel: "sms",
    address: "+14155551000",
  });
  events.record({
    householdId: hhA,
    endpointId: epUnread.id,
    direction: "inbound",
    channel: "sms",
    provider: "twilio",
    externalMessageId: "SM_in_unread",
    fromAddress: "+14155551000",
    toAddress: "+14155559999",
    body: "hey, can we reschedule?",
    receivedAt: iso(-30 * 60 * 1000),
  });

  // Endpoint + outbound event that failed delivery.
  const epFail = endpoints.create({
    householdId: hhA,
    channel: "sms",
    address: "+14155551001",
  });
  const failed = events.record({
    householdId: hhA,
    endpointId: epFail.id,
    direction: "outbound",
    channel: "sms",
    provider: "twilio",
    externalMessageId: "SM_out_failed",
    fromAddress: "+14155559999",
    toAddress: "+14155551001",
    body: "we're on the way",
    receivedAt: iso(-60 * 60 * 1000),
  });
  events.updateDeliveryStatus({
    provider: "twilio",
    externalMessageId: "SM_out_failed",
    status: "failed",
    errorCode: "30003",
  });
  expect(failed.inserted).toBe(true);

  // Endpoint + inbound + subsequent outbound (should NOT count as
  // unread — we replied).
  const epReplied = endpoints.create({
    householdId: hhA,
    channel: "sms",
    address: "+14155551002",
  });
  events.record({
    householdId: hhA,
    endpointId: epReplied.id,
    direction: "inbound",
    channel: "sms",
    provider: "twilio",
    externalMessageId: "SM_in_replied",
    fromAddress: "+14155551002",
    toAddress: "+14155559999",
    body: "you around?",
    receivedAt: iso(-2 * 60 * 60 * 1000),
  });
  events.record({
    householdId: hhA,
    endpointId: epReplied.id,
    direction: "outbound",
    channel: "sms",
    provider: "twilio",
    externalMessageId: "SM_out_reply",
    fromAddress: "+14155559999",
    toAddress: "+14155551002",
    body: "yes, one sec",
    receivedAt: iso(-1 * 60 * 60 * 1000),
  });

  // Upcoming obligation (5 days out) + far-future obligation
  // (60 days — should NOT surface) + already-old-overdue (100
  // days ago — must be filtered out).
  const provenance = {
    source: "customer_direct",
    assertedBy: m.id,
    assertedAt: new Date().toISOString(),
    confidence: 1,
    status: "confirmed" as const,
  };
  graph.createNode(hhA, {
    type: "obligation.deadline",
    data: {
      title: "Passport renewal",
      dueAt: iso(5 * 24 * 60 * 60 * 1000),
      category: "renewal",
    },
    provenance,
  });
  graph.createNode(hhA, {
    type: "obligation.deadline",
    data: {
      title: "Far-future review",
      dueAt: iso(60 * 24 * 60 * 60 * 1000),
      category: "personal",
    },
    provenance,
  });
  graph.createNode(hhA, {
    type: "obligation.deadline",
    data: {
      title: "Stale overdue",
      dueAt: iso(-100 * 24 * 60 * 60 * 1000),
      category: "other",
    },
    provenance,
  });

  // Noise for hhC (not granted) — must not appear in results.
  const epNoise = endpoints.create({
    householdId: hhC,
    channel: "sms",
    address: "+14155551003",
  });
  events.record({
    householdId: hhC,
    endpointId: epNoise.id,
    direction: "inbound",
    channel: "sms",
    provider: "twilio",
    externalMessageId: "SM_noise",
    fromAddress: "+14155551003",
    toAddress: "+14155559999",
    body: "should not appear",
    receivedAt: iso(-15 * 60 * 1000),
  });

  app = buildServer(db);
  await app.ready();
});

afterAll(async () => await app.close());

describe("GET /me/attention", () => {
  it("aggregates delivery failures, unread threads, frozen households and upcoming obligations across every granted household, ranked, with hhC absent", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/me/attention",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      generatedAt: string;
      items: Array<{
        kind: string;
        householdId: string;
        householdName: string;
        summary: string;
        detail: Record<string, unknown>;
      }>;
      counts: {
        deliveryFailures: number;
        unreadThreads: number;
        upcomingObligations: number;
        frozenHouseholds: number;
      };
    };

    expect(body.counts.deliveryFailures).toBe(1);
    expect(body.counts.unreadThreads).toBe(1);
    expect(body.counts.upcomingObligations).toBe(1);
    expect(body.counts.frozenHouseholds).toBe(1);

    // hhC must not appear.
    expect(
      body.items.every((it) => it.householdId !== hhC),
    ).toBe(true);

    // Ranking: delivery_failure first, then frozen_household,
    // then unread_thread, then upcoming_obligation.
    expect(body.items[0]?.kind).toBe("delivery_failure");
    expect(body.items[1]?.kind).toBe("frozen_household");
    expect(body.items[2]?.kind).toBe("unread_thread");
    expect(body.items[3]?.kind).toBe("upcoming_obligation");
    expect(body.items).toHaveLength(4);

    // Attribute spot-checks.
    const failure = body.items.find((it) => it.kind === "delivery_failure");
    expect(failure?.summary).toContain("failed");
    expect(failure?.detail.deliveryStatus).toBe("failed");
    expect(failure?.detail.deliveryErrorCode).toBe("30003");

    const frozen = body.items.find((it) => it.kind === "frozen_household");
    expect(frozen?.householdId).toBe(hhB);
    expect(frozen?.summary).toContain("frozen");
    expect(frozen?.summary).toContain("manual pause");

    const unread = body.items.find((it) => it.kind === "unread_thread");
    expect(unread?.householdId).toBe(hhA);
    expect(unread?.summary).toContain("reschedule");

    const upcoming = body.items.find(
      (it) => it.kind === "upcoming_obligation",
    );
    expect(upcoming?.summary).toContain("Passport renewal");
  });
});
