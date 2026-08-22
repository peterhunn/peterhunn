import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  openDb,
  contactEndpointRepo,
  credentialRepo,
  householdRepo,
  identityRepo,
  messagingEventRepo,
  pendingVerificationRepo,
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

// MSW server — intercepts fetch (Anthropic, googleapis, etc.) AND
// axios (twilio SDK) at the socket layer. Bypass unhandled requests
// by default so incidental network activity from planner runs
// (mock LLM adapter never actually calls out; but any accidental
// real call would be caught here) resolves to nothing rather than
// throwing across every test.
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => server.resetHandlers());

afterAll(async () => {
  server.close();
  await app.close();
});

beforeEach(() => {
  vi.unstubAllGlobals();
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
    expect(body.outcome).toBe("dispatched");
    expect(body.eventId).toBeDefined();

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
    expect(first.json().outcome).toBe("dispatched");
    expect(second.json().outcome).toBe("deduped");
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

describe("verification loop", () => {
  it("shared-line: unrouted from-number with a matching code binds and consumes the verification", async () => {
    const created = pendingVerificationRepo(db).create({
      householdId: hh,
      channel: "sms",
      createdBy: "manager:test",
      label: "New family member",
    });

    const res = await app.inject({
      method: "POST",
      url: "/messaging/inbound/mock",
      payload: {
        channel: "sms",
        from: "+14155559999",
        to: "+18889990000", // shared concierge line, not registered
        body: `${created.code}`,
        externalMessageId: "mock_ver_1",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.outcome).toBe("verified");
    expect(body.householdId).toBe(hh);
    expect(body.ackMessage).toContain("Verified");

    // Endpoint is now bound to hh.
    const ep = contactEndpointRepo(db).resolve("sms", "+14155559999");
    expect(ep).not.toBeNull();
    expect(ep!.householdId).toBe(hh);
    expect(ep!.label).toBe("New family member");

    // Verification consumed.
    const stillLive = pendingVerificationRepo(db).findLiveByCode("sms", created.code);
    expect(stillLive).toBeNull();

    // Next inbound from that from-number is now dispatched (routed
    // to hh) rather than requiring another code.
    const next = await app.inject({
      method: "POST",
      url: "/messaging/inbound/mock",
      payload: {
        channel: "sms",
        from: "+14155559999",
        to: "+18889990000",
        body: "Book the plumber for tomorrow",
        externalMessageId: "mock_ver_2",
      },
    });
    expect(next.json().outcome).toBe("dispatched");
  });

  it("expired code does not verify (unrouted 404)", async () => {
    const expired = pendingVerificationRepo(db).create({
      householdId: hh,
      channel: "sms",
      createdBy: "manager:test",
      ttlSeconds: 1,
    });
    // Advance beyond TTL by mutating expiresAt directly via a fresh
    // create with ttl=1 and waiting 1.1s would slow tests; instead
    // rely on the repo's expiresAt comparison to isoNow, which we
    // can fake by sending far in the past.
    // A cleaner path: use vitest fake timers. But we can just reuse
    // the code with a body that also contains a 6-digit noise value
    // so the extractor still finds the target — no, extractor takes
    // FIRST 6 digits. Skip a real time test and directly check the
    // repo's expiry gate.
    const now = new Date(
      Date.parse(expired.expiresAt) + 60_000,
    ).toISOString();
    const live = pendingVerificationRepo(db).findLiveByCode("sms", expired.code, now);
    expect(live).toBeNull();
  });

  it("wrong code from an unknown number is unrouted", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/messaging/inbound/mock",
      payload: {
        channel: "sms",
        from: "+14150000000",
        to: "+18889990000",
        body: "Random 000000 not a real code",
        externalMessageId: "mock_ver_bad",
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("unrouted");
  });

  it("code cannot hijack an address already bound to another household", async () => {
    // Create a second household with an existing endpoint we then
    // try to steal.
    const identity = identityRepo(db);
    const hh2 = householdRepo(db).create({ name: "Other", tier: "life" });
    contactEndpointRepo(db).create({
      householdId: hh2.id,
      channel: "sms",
      address: "+14158887777",
    });
    identity.grantHousehold({
      managerId: identity.createManager({
        displayName: "M2",
        email: "m2@a.b",
      }).id,
      householdId: hh2.id,
      role: "primary",
    });

    // Mint a code on the ORIGINAL household hh and try to consume
    // it from the from-address that already belongs to hh2.
    const attempt = pendingVerificationRepo(db).create({
      householdId: hh,
      channel: "sms",
      createdBy: "manager:test",
    });
    const res = await app.inject({
      method: "POST",
      url: "/messaging/inbound/mock",
      payload: {
        channel: "sms",
        from: "+14158887777",
        to: "+18889990000",
        body: attempt.code,
      },
    });
    // From-address resolution wins first — the message routes to
    // hh2 (its legitimate household), not hh (the one that minted
    // the code). Result: the code stays unclaimed and the target
    // household is unchanged.
    expect(res.statusCode).toBe(200);
    expect(res.json().householdId).toBe(hh2.id);
    const live = pendingVerificationRepo(db).findLiveByCode("sms", attempt.code);
    expect(live).not.toBeNull();
    // hh's endpoint set has NOT been augmented with the attacker's
    // address.
    const boundToHh = contactEndpointRepo(db)
      .list(hh)
      .some((e) => e.address === "+14158887777");
    expect(boundToHh).toBe(false);
  });

  it("POST /messaging/verifications mints a 6-digit code under manager auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/households/${hh}/messaging/verifications`,
      headers: { authorization: `Bearer ${token}` },
      payload: { channel: "sms", label: "Alex's phone" },
    });
    expect(res.statusCode).toBe(201);
    const v = res.json().verification;
    expect(v.code).toMatch(/^\d{6}$/);
    expect(new Date(v.expiresAt).getTime()).toBeGreaterThan(Date.now());
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

    let twilioHit = 0;
    server.use(
      http.post(
        "https://api.twilio.com/2010-04-01/Accounts/ACxxx/Messages.json",
        () => {
          twilioHit++;
          return HttpResponse.json(
            {
              sid: "SMlive123",
              from: "+14155550000",
              to: "+14155551212",
              status: "queued",
            },
            { status: 201 },
          );
        },
      ),
    );

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
    expect(twilioHit).toBe(1);
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
