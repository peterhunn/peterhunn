import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  openDb,
  contactEndpointRepo,
  householdRepo,
  identityRepo,
  inboxRepo,
  messagingEventRepo,
} from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";
import { buildServer } from "../src/server.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let db: ReturnType<typeof openDb>;
let token: string;
let hh: HouseholdId;
const alexId = "prn_alex";
const bobId = "prn_bob";

const iso = (offsetMs: number): string =>
  new Date(Date.now() + offsetMs).toISOString();

beforeAll(async () => {
  db = openDb({ url: ":memory:" });
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: "../../packages/db/migrations" });

  const identity = identityRepo(db);
  const m = identity.createManager({ displayName: "M", email: "m@a.b" });
  token = identity.mintToken({ actorType: "manager", actorId: m.id, label: "t" }).token;
  hh = householdRepo(db).create({ name: "H", tier: "life" }).id;
  identity.grantHousehold({ managerId: m.id, householdId: hh, role: "primary" });

  const endpoints = contactEndpointRepo(db);
  const events = messagingEventRepo(db);
  const inbox = inboxRepo(db);

  // Alex owns an SMS number and an email endpoint.
  const alexSms = endpoints.create({
    householdId: hh,
    channel: "sms",
    address: "+14155550001",
    principalId: alexId,
  });
  endpoints.create({
    householdId: hh,
    channel: "email",
    address: "Alex@Example.COM",
    principalId: alexId,
  });

  // Bob owns his own SMS number — should NOT appear on Alex's feed.
  const bobSms = endpoints.create({
    householdId: hh,
    channel: "sms",
    address: "+14155559999",
    principalId: bobId,
  });

  // Alex inbound SMS (2h ago).
  events.record({
    householdId: hh,
    endpointId: alexSms.id,
    direction: "inbound",
    channel: "sms",
    provider: "twilio",
    externalMessageId: "SM_alex_in",
    fromAddress: "+14155550001",
    toAddress: "+14155559998",
    body: "hey any update on the plumber?",
    receivedAt: iso(-2 * 60 * 60 * 1000),
  });
  // Alex outbound SMS reply (1h ago).
  events.record({
    householdId: hh,
    endpointId: alexSms.id,
    direction: "outbound",
    channel: "sms",
    provider: "twilio",
    externalMessageId: "SM_alex_out",
    fromAddress: "+14155559998",
    toAddress: "+14155550001",
    body: "Thursday morning is booked.",
    receivedAt: iso(-1 * 60 * 60 * 1000),
  });
  // Bob inbound SMS — noise; must not show on Alex.
  events.record({
    householdId: hh,
    endpointId: bobSms.id,
    direction: "inbound",
    channel: "sms",
    provider: "twilio",
    externalMessageId: "SM_bob_in",
    fromAddress: "+14155559999",
    toAddress: "+14155559998",
    body: "different customer",
    receivedAt: iso(-30 * 60 * 1000),
  });

  // Alex inbound email — matched by fromAddress against Alex's
  // email endpoint (case-insensitive via normalizeAddress).
  inbox.upsertExternal({
    householdId: hh,
    externalProvider: "gmail",
    externalMessageId: "gm_alex_1",
    fromName: "Alex",
    fromAddress: "alex@example.com",
    subject: "Re: dinner Friday",
    body: "8pm works. Where should we meet?",
    receivedAt: iso(-45 * 60 * 1000),
  });
  // Outbound email sent TO Alex (from the household's Gmail
  // account) — matched by toAddress against Alex's email endpoint.
  // This mirrors what a `mailbox: "sent"` sync would insert.
  inbox.upsertExternal({
    householdId: hh,
    externalProvider: "gmail",
    externalMessageId: "gm_alex_sent_1",
    direction: "outbound",
    fromName: "Household",
    fromAddress: "household@atelier.example",
    toAddress: "alex@example.com",
    subject: "Re: dinner Friday",
    body: "Sounds great — see you at the wine bar on 5th.",
    receivedAt: iso(-15 * 60 * 1000),
  });
  // Vendor email — no endpoint match, no recipientPrincipalId. Must
  // not show on any principal's feed.
  inbox.upsertExternal({
    householdId: hh,
    externalProvider: "gmail",
    externalMessageId: "gm_vendor",
    fromName: "Vendor",
    fromAddress: "vendor@somewhere.example",
    subject: "Invoice #123",
    body: "Please pay.",
    receivedAt: iso(-3 * 60 * 60 * 1000),
  });
  // Manager-created inbox entry that explicitly names Alex as the
  // recipient principal — no endpoint match needed.
  inbox.create({
    householdId: hh,
    fromName: "Attorney",
    fromAddress: "counsel@firm.example",
    recipientPrincipalId: alexId,
    subject: "Contract review",
    body: "Signed and returned.",
    receivedAt: iso(-6 * 60 * 60 * 1000),
  });

  app = buildServer(db);
  await app.ready();
});

afterAll(async () => await app.close());

describe("GET /households/:id/customers/:principalId/activity", () => {
  it("interleaves SMS + email for one principal, ordered newest first, and scopes to only that principal's endpoints", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/households/${hh}/customers/${alexId}/activity`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      principalId: string;
      endpoints: Array<{ channel: string; address: string }>;
      items: Array<{
        source: string;
        direction: string;
        at: string;
        body: string;
        refId: string;
        refKind: string;
      }>;
      counts: { sms: number; whatsapp: number; imessage: number; email: number };
    };

    expect(body.principalId).toBe(alexId);
    // Two endpoints: SMS + email (both stored normalised).
    expect(body.endpoints).toHaveLength(2);
    expect(body.endpoints.some((e) => e.channel === "sms")).toBe(true);
    expect(body.endpoints.some((e) => e.channel === "email")).toBe(true);

    // Counts: 2 SMS + 3 email (1 outbound + 2 inbound) = 5.
    expect(body.counts.sms).toBe(2);
    expect(body.counts.email).toBe(3);
    expect(body.items).toHaveLength(5);
    for (const item of body.items) {
      expect(["sms", "email"]).toContain(item.source);
    }

    // Order: newest first. Interleaved across channels.
    for (let i = 1; i < body.items.length; i++) {
      expect(body.items[i - 1]!.at >= body.items[i]!.at).toBe(true);
    }
    // The most recent item is the -15m outbound email (SENT-sync
    // path), matched via toAddress = Alex's email.
    expect(body.items[0]!.source).toBe("email");
    expect(body.items[0]!.direction).toBe("outbound");
    expect(body.items[0]!.body).toContain("wine bar");

    // Second — the -45m inbound email match (fromAddress).
    expect(body.items[1]!.source).toBe("email");
    expect(body.items[1]!.direction).toBe("inbound");
    expect(body.items[1]!.refKind).toBe("inbox_message");
    expect(body.items[1]!.body).toContain("8pm");

    // Third — Alex's outbound SMS from -1h.
    expect(body.items[2]!.source).toBe("sms");
    expect(body.items[2]!.direction).toBe("outbound");
    expect(body.items[2]!.body).toContain("Thursday");

    // Manager-created inbox with recipientPrincipalId=Alex is also
    // included (matched by the principalId path, no endpoint needed).
    expect(
      body.items.some(
        (i) => i.source === "email" && i.body.includes("Signed and returned"),
      ),
    ).toBe(true);

    // Bob's SMS + vendor email absent.
    expect(body.items.some((i) => i.body === "different customer")).toBe(false);
    expect(body.items.some((i) => i.body === "Please pay.")).toBe(false);
  });

  it("returns an empty activity feed for a principal with no endpoints and no direct-addressed inbox rows", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/households/${hh}/customers/prn_stranger/activity`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toEqual([]);
    expect(body.endpoints).toEqual([]);
  });
});
