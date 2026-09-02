import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  openDb,
  contactEndpointRepo,
  householdRepo,
  identityRepo,
} from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";
import { buildServer } from "../src/server.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let db: ReturnType<typeof openDb>;
let token: string;
let hhOff: HouseholdId;
let hhOn: HouseholdId;

beforeAll(async () => {
  db = openDb({ url: ":memory:" });
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: "../../packages/db/migrations" });

  const identity = identityRepo(db);
  const m = identity.createManager({ displayName: "M", email: "m@a.b" });
  token = identity.mintToken({
    actorType: "manager",
    actorId: m.id,
    label: "t",
  }).token;
  const households = householdRepo(db);
  const endpoints = contactEndpointRepo(db);

  // Household A — flag stays at the default (off). Its concierge
  // line answers inbound texts with an empty TwiML.
  const a = households.create({ name: "A", tier: "life" });
  hhOff = a.id;
  identity.grantHousehold({ managerId: m.id, householdId: hhOff, role: "primary" });
  endpoints.create({
    householdId: hhOff,
    channel: "sms",
    address: "+14155550001",
    label: "concierge",
  });

  // Household B — flag turned on. Its concierge line answers with
  // the "Got it — I'm on this" reply.
  const b = households.create({ name: "B", tier: "life" });
  hhOn = b.id;
  identity.grantHousehold({ managerId: m.id, householdId: hhOn, role: "primary" });
  households.setInstantAck(hhOn, true);
  endpoints.create({
    householdId: hhOn,
    channel: "sms",
    address: "+14155550002",
    label: "concierge",
  });

  app = buildServer(db);
  await app.ready();
});

afterAll(async () => await app.close());

describe("concierge instant-ack per-household flag", () => {
  it("default (off) — twilio webhook returns empty TwiML on a routed inbound; no agent-authored reply reaches the customer", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/messaging/inbound/twilio",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload:
        "From=%2B14155559991&To=%2B14155550001&Body=hey&MessageSid=SM_off_1",
    });
    expect(res.statusCode).toBe(200);
    // Empty <Response/> — the customer sees nothing back from the
    // system. Manager sees the inbound in the console and replies
    // deliberately.
    expect(res.body).toMatch(/<Response\s*\/>|<Response><\/Response>/);
    expect(res.body).not.toContain("<Message>");
    expect(res.body).not.toContain("Got it");
  });

  it("flag on — twilio webhook returns the instant ack TwiML on a routed inbound", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/messaging/inbound/twilio",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload:
        "From=%2B14155559992&To=%2B14155550002&Body=hey&MessageSid=SM_on_1",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<Message>");
    expect(res.body).toMatch(/Got it — I(&apos;|')m on this/);
  });

  it("STOP consent confirmation fires even when the flag is off — legally required", async () => {
    // Household A has the flag off, but a STOP reply must still get
    // a confirmation SMS to satisfy TCPA regardless of household
    // preferences. Route the inbound to a dedicated STOP-only
    // concierge line so the consent side-effect (endpoints.
    // setConsent) doesn't leak into the toggle test that follows,
    // which needs hhOff's concierge line un-opted-out.
    householdRepo(db).create({ name: "A-stop", tier: "life" });
    // Use a distinct concierge address just for this test.
    contactEndpointRepo(db).create({
      householdId: hhOff,
      channel: "sms",
      address: "+14155550101",
    });
    const res = await app.inject({
      method: "POST",
      url: "/messaging/inbound/twilio",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload:
        "From=%2B14155559993&To=%2B14155550101&Body=STOP&MessageSid=SM_stop_1",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<Message>");
    expect(res.body).toContain("unsubscribed");
  });

  it("POST /households/:id/instant-ack toggles the flag and the change takes effect immediately", async () => {
    const enable = await app.inject({
      method: "POST",
      url: `/households/${hhOff}/instant-ack`,
      headers: { authorization: `Bearer ${token}` },
      payload: { enabled: true },
    });
    expect(enable.statusCode).toBe(200);
    expect(enable.json().household.instantAckEnabled).toBe(true);

    const after = await app.inject({
      method: "POST",
      url: "/messaging/inbound/twilio",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload:
        "From=%2B14155559994&To=%2B14155550001&Body=any&MessageSid=SM_off_after_1",
    });
    expect(after.body).toContain("<Message>");
    expect(after.body).toMatch(/Got it — I(&apos;|')m on this/);

    // Turn back off — the ack goes silent again.
    const disable = await app.inject({
      method: "POST",
      url: `/households/${hhOff}/instant-ack`,
      headers: { authorization: `Bearer ${token}` },
      payload: { enabled: false },
    });
    expect(disable.json().household.instantAckEnabled).toBe(false);
    const silent = await app.inject({
      method: "POST",
      url: "/messaging/inbound/twilio",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload:
        "From=%2B14155559995&To=%2B14155550001&Body=any2&MessageSid=SM_off_after_2",
    });
    expect(silent.body).not.toContain("<Message>");
  });
});
