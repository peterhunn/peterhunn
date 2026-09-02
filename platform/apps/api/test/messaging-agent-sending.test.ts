import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  openDb,
  contactEndpointRepo,
  credentialRepo,
  householdRepo,
  identityRepo,
  messagingEventRepo,
} from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";
import { buildServer } from "../src/server.js";
import { sendOutboundEmail, sendOutboundMessage } from "../src/messaging-outbound.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let db: ReturnType<typeof openDb>;
let token: string;
let hh: HouseholdId;

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
  hh = householdRepo(db).create({ name: "H", tier: "life" }).id;
  identity.grantHousehold({ managerId: m.id, householdId: hh, role: "primary" });
  contactEndpointRepo(db).create({
    householdId: hh,
    channel: "sms",
    address: "+14155550001",
  });
  contactEndpointRepo(db).create({
    householdId: hh,
    channel: "sms",
    address: "+14155559991",
  });

  app = buildServer(db);
  await app.ready();
});

afterAll(async () => await app.close());

describe("household.agentSendingEnabled gate — the wire seam", () => {
  it("SMS: refuses an agent-authored send when the household hasn't opted in", async () => {
    const out = await sendOutboundMessage(db, {
      householdId: hh,
      channel: "sms",
      to: "+14155559991",
      body: "Concierge draft.",
      authoredBy: { type: "agent", id: "concierge/0.1.0", label: "concierge" },
    });
    expect(out.refused).toBe("agent_sending_disabled");
    expect(out.eventId).toBeUndefined();
    // Wire refusal means no messaging_events row is recorded —
    // the send never happened, so there's nothing to record.
    const events = messagingEventRepo(db).list(hh);
    expect(
      events.some((e) => e.direction === "outbound" && e.body === "Concierge draft."),
    ).toBe(false);
  });

  it("SMS: manager-authored sends bypass the flag entirely", async () => {
    // Flag still off — same household. Manager-authored send
    // proceeds and records the outbound event.
    const out = await sendOutboundMessage(db, {
      householdId: hh,
      channel: "sms",
      to: "+14155559991",
      body: "Manager typed this.",
      authoredBy: { type: "manager", id: "mgr_test", label: "Manager Alex" },
    });
    expect(out.refused).toBeUndefined();
    expect(out.eventId).toBeDefined();
    const row = messagingEventRepo(db)
      .list(hh)
      .find((e) => e.id === out.eventId);
    expect(row?.authoredByType).toBe("manager");
  });

  it("SMS: flag on lets agent sends through", async () => {
    householdRepo(db).setAgentSending(hh, true);
    const out = await sendOutboundMessage(db, {
      householdId: hh,
      channel: "sms",
      to: "+14155559991",
      body: "Agent draft (allowed).",
      authoredBy: { type: "agent", id: "concierge/0.1.0", label: "concierge" },
    });
    expect(out.refused).toBeUndefined();
    expect(out.eventId).toBeDefined();
    const row = messagingEventRepo(db)
      .list(hh)
      .find((e) => e.id === out.eventId);
    expect(row?.authoredByType).toBe("agent");
    // Reset the flag so subsequent tests here see the default.
    householdRepo(db).setAgentSending(hh, false);
  });

  it("email: refuses an agent-authored send when the flag is off", async () => {
    // Seed a gmail credential so the refusal isn't just
    // "not connected" — we want the agent gate to be the reason.
    credentialRepo(db).store({
      householdId: hh,
      provider: "gmail",
      kind: "oauth2",
      label: "Gmail",
      credential: {
        access_token: "at",
        from_address: "household@atelier.example",
      },
    });
    const out = await sendOutboundEmail(db, {
      householdId: hh,
      toName: "Sam",
      toAddress: "sam@example.com",
      subject: "Auto-reply",
      body: "Agent drafted this.",
      authoredBy: { type: "agent", id: "inbox/0.1.0", label: "inbox" },
    });
    expect(out.refused).toBe("agent_sending_disabled");
    expect(out.sentMessageId).toBe("");
    expect(out.inboxMessageId).toBe("");
  });

  it("POST /households/:id/agent-sending toggles the flag; changes take effect immediately", async () => {
    const enable = await app.inject({
      method: "POST",
      url: `/households/${hh}/agent-sending`,
      headers: { authorization: `Bearer ${token}` },
      payload: { enabled: true },
    });
    expect(enable.statusCode).toBe(200);
    expect(enable.json().household.agentSendingEnabled).toBe(true);

    const allowed = await sendOutboundMessage(db, {
      householdId: hh,
      channel: "sms",
      to: "+14155559991",
      body: "Agent draft after toggle.",
      authoredBy: { type: "agent", id: "concierge/0.1.0", label: "concierge" },
    });
    expect(allowed.refused).toBeUndefined();

    const disable = await app.inject({
      method: "POST",
      url: `/households/${hh}/agent-sending`,
      headers: { authorization: `Bearer ${token}` },
      payload: { enabled: false },
    });
    expect(disable.json().household.agentSendingEnabled).toBe(false);

    const refused = await sendOutboundMessage(db, {
      householdId: hh,
      channel: "sms",
      to: "+14155559991",
      body: "Agent draft after disable.",
      authoredBy: { type: "agent", id: "concierge/0.1.0", label: "concierge" },
    });
    expect(refused.refused).toBe("agent_sending_disabled");
  });
});
