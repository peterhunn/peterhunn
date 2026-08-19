import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
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
  const m = identity.createManager({ displayName: "M", email: "m@a.b" });
  token = identity.mintToken({ actorType: "manager", actorId: m.id, label: "t" }).token;
  const household = householdRepo(db).create({ name: "H", tier: "life" });
  hh = household.id;
  identity.grantHousehold({ managerId: m.id, householdId: hh, role: "primary" });
  contactEndpointRepo(db).create({
    householdId: hh,
    channel: "sms",
    address: "+14155550000",
    label: "Concierge line",
  });

  app = buildServer(db);
  await app.ready();
});

afterAll(async () => await app.close());

beforeEach(() => {
  vi.unstubAllGlobals();
  // Block any tool that would hit real HTTP during a planner run.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 })),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("messaging inbound", () => {
  it("mock webhook resolves the household, records the event, and fires the planner", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/messaging/inbound/mock",
      payload: {
        channel: "sms",
        from: "+14155551212",
        to: "+14155550000",
        body: "Book the plumber for Thursday, kitchen sink leaking again.",
        externalMessageId: "mock_msg_1",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.eventId).toBeDefined();
    expect(body.deduped).toBe(false);

    const events = messagingEventRepo(db).list(hh);
    expect(events.length).toBe(1);
    expect(events[0]!.direction).toBe("inbound");
    expect(events[0]!.channel).toBe("sms");
    expect(events[0]!.provider).toBe("mock");
    expect(events[0]!.body).toContain("plumber");
  });

  it("dedupes on the provider message id (webhook retry is safe)", async () => {
    const send = () =>
      app.inject({
        method: "POST",
        url: "/messaging/inbound/mock",
        payload: {
          channel: "sms",
          from: "+14155551212",
          to: "+14155550000",
          body: "Duplicate delivery",
          externalMessageId: "mock_msg_dup",
        },
      });
    const first = await send();
    const second = await send();
    expect(first.json().deduped).toBe(false);
    expect(second.json().deduped).toBe(true);
  });

  it("404s a mock webhook for an unregistered destination number", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/messaging/inbound/mock",
      payload: {
        channel: "sms",
        from: "+14155551212",
        to: "+19999999999",
        body: "who dis",
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("unrouted");
  });

  it("twilio webhook parses form-encoded body and returns TwiML", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/messaging/inbound/twilio",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload:
        "From=%2B14155551212&To=%2B14155550000&Body=Reschedule%20dentist&MessageSid=SM_test_1",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/xml");
    expect(res.body).toContain("<Response>");
    expect(res.body).toContain("<Message>");
  });

  it("twilio webhook for unrouted number still returns empty TwiML 200", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/messaging/inbound/twilio",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload:
        "From=%2B14155551212&To=%2B19999999999&Body=who&MessageSid=SM_test_unrouted",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<Response/>");
  });
});

describe("messaging outbound send", () => {
  it("uses the mock provider when no twilio credential is stored", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/households/${hh}/messaging/send`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        channel: "sms",
        to: "+14155551212",
        body: "Just checking in.",
      },
    });
    expect(res.statusCode).toBe(200);
    const sent = res.json().sent;
    expect(sent.provider).toBe("mock");
    expect(sent.externalMessageId).toMatch(/^mock-sms-/);
    expect(sent.reason).toBe("no_twilio_credential");

    const outbound = messagingEventRepo(db)
      .list(hh)
      .filter((e) => e.direction === "outbound");
    expect(outbound.length).toBeGreaterThan(0);
    expect(outbound[0]!.provider).toBe("mock");
  });

  it("calls the Twilio Messages API when a credential is stored and records the twilio id", async () => {
    credentialRepo(db).store({
      householdId: hh,
      provider: "twilio",
      kind: "api_key",
      label: "Twilio",
      credential: {
        account_sid: "ACxxx",
        auth_token: "tok",
        from_number: "+14155550000",
      },
    });

    const twilioSpy = vi.fn(async (url: string) => {
      if (url.includes("/Accounts/ACxxx/Messages.json")) {
        return new Response(
          JSON.stringify({
            sid: "SMlive123",
            from: "+14155550000",
            to: "+14155551212",
            status: "queued",
          }),
          { status: 201 },
        );
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", twilioSpy);

    const res = await app.inject({
      method: "POST",
      url: `/households/${hh}/messaging/send`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        channel: "sms",
        to: "+14155551212",
        body: "Live send",
      },
    });
    expect(res.statusCode).toBe(200);
    const sent = res.json().sent;
    expect(sent.provider).toBe("twilio");
    expect(sent.externalMessageId).toBe("SMlive123");
    expect(twilioSpy).toHaveBeenCalled();
  });
});

describe("messaging endpoints CRUD", () => {
  it("lists, creates, and revokes endpoints under manager auth", async () => {
    const list1 = await app.inject({
      method: "GET",
      url: `/households/${hh}/messaging/endpoints`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list1.statusCode).toBe(200);
    const initialCount = list1.json().endpoints.length;

    const create = await app.inject({
      method: "POST",
      url: `/households/${hh}/messaging/endpoints`,
      headers: { authorization: `Bearer ${token}` },
      payload: { channel: "whatsapp", address: "+14155551333", label: "WA" },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().endpoint.id;

    const list2 = await app.inject({
      method: "GET",
      url: `/households/${hh}/messaging/endpoints`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list2.json().endpoints.length).toBe(initialCount + 1);

    const revoke = await app.inject({
      method: "DELETE",
      url: `/households/${hh}/messaging/endpoints/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(revoke.statusCode).toBe(204);
  });

  it("409s a duplicate (channel, address)", async () => {
    const create = await app.inject({
      method: "POST",
      url: `/households/${hh}/messaging/endpoints`,
      headers: { authorization: `Bearer ${token}` },
      payload: { channel: "sms", address: "+14155550000" },
    });
    expect(create.statusCode).toBe(409);
  });
});
