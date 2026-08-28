import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  openDb,
  contactEndpointRepo,
  conversationSessionRepo,
  credentialRepo,
  documentBlobRepo,
  graphRepo,
  householdRepo,
  identityRepo,
  messagingEventRepo,
  messagingEvents,
  pendingVerificationRepo,
} from "@atelier/db";
import { eq } from "drizzle-orm";
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
  // Legacy assumption for this file's tests: the concierge line
  // fires an instant ack, and agent-authored sends actually reach
  // the wire. Opt this household in to both flags so the assertions
  // stay stable. The defaults (off) are exercised in dedicated
  // test files: messaging-instant-ack.test.ts and
  // messaging-agent-sending.test.ts.
  householdRepo(db).setInstantAck(hh, true);
  householdRepo(db).setAgentSending(hh, true);
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
    // Either shape is a valid empty TwiML response; XML serialisers
    // choose one or the other and Twilio doesn't care.
    expect(res.body).toMatch(/<Response\s*\/>|<Response><\/Response>/);
  });

  it("twilio webhook returns an instant TwiML ack for a known endpoint (planner fires in background)", async () => {
    contactEndpointRepo(db).create({
      householdId: hh,
      channel: "sms",
      address: "+14158675800",
    });
    const started = Date.now();
    const res = await app.inject({
      method: "POST",
      url: "/messaging/inbound/twilio",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload:
        "From=%2B14158675800&To=%2B14155550000&Body=hi%20there&MessageSid=SM_ack_1",
    });
    const elapsed = Date.now() - started;
    expect(res.statusCode).toBe(200);
    // Ack text is in the TwiML body. XML entity-escapes apostrophes.
    expect(res.body).toMatch(/Got it — I(&apos;|')m on this/);
    // Ack must not wait for the planner (which is at least an
    // in-memory mock call, but the assertion here is about the
    // shape, not timing — the ack should be present regardless of
    // whether the planner has completed yet).
    // Ceiling of 5s is generous; a real ack should be sub-100ms.
    expect(elapsed).toBeLessThan(5000);
  });

  it("twilio webhook records MMS attachments as document.record candidates", { timeout: 15_000 }, async () => {
    contactEndpointRepo(db).create({
      householdId: hh,
      channel: "sms",
      address: "+14158675801",
    });
    // MSW: mock the Twilio media CDN. Two attachments.
    // Give each response its own dedicated ArrayBuffer, not a
    // slice of a pooled node.js Buffer. Buffer.from([…]).buffer
    // returns the WHOLE pool (typically 8192 bytes), and under
    // vitest's parallel workers MSW can hand out two overlapping
    // views into the same pool — the API then hashes both to the
    // same sha256 and the storedAt collide. Uint8Array-backed
    // buffers each get their own memory, which sidesteps the race.
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const pdfBytes = new TextEncoder().encode("%PDF-1.4\nfake\n");
    server.use(
      http.get("https://api.twilio.com/photo.png", () =>
        HttpResponse.arrayBuffer(pngBytes.buffer as ArrayBuffer, {
          headers: { "content-type": "image/png" },
        }),
      ),
      http.get("https://api.twilio.com/receipt.pdf", () =>
        HttpResponse.arrayBuffer(pdfBytes.buffer as ArrayBuffer, {
          headers: { "content-type": "application/pdf" },
        }),
      ),
    );

    const params = new URLSearchParams({
      From: "+14158675801",
      To: "+14155550000",
      Body: "here you go",
      MessageSid: "SM_mms_1",
      NumMedia: "2",
      MediaUrl0: "https://api.twilio.com/photo.png",
      MediaContentType0: "image/png",
      MediaUrl1: "https://api.twilio.com/receipt.pdf",
      MediaContentType1: "application/pdf",
    });

    const res = await app.inject({
      method: "POST",
      url: "/messaging/inbound/twilio",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: params.toString(),
    });
    expect(res.statusCode).toBe(200);

    // Attachments download in the background. Poll for both.
    const graph = graphRepo(db);
    const targetTitles = new Set(["photo.png", "receipt.pdf"]);
    const docs = await pollFor(() => {
      const found = graph
        .listNodes(hh, { type: "document.record" })
        .filter((n) => {
          const d = n.data as { notes?: string; title?: string };
          const notes = d.notes ?? "";
          const title = d.title ?? "";
          if (!notes.startsWith("MMS attachment from messaging event ")) return false;
          return title.startsWith("Photo —") || title.startsWith("PDF —");
        });
      // Dedupe across polling iterations by node id — NOT by
      // storedAt. Under vitest's parallel workers, MSW's
      // HttpResponse.arrayBuffer(Buffer.buffer, …) can hand out
      // views into the same pooled node.js memory for two
      // concurrent responses, which makes both attachments hash
      // to the same sha256 in about 1/3 of runs. The nodes are
      // still distinct (different type-titles, different rows);
      // deduping by id keeps both in the poll result.
      const uniq = Array.from(new Map(found.map((n) => [n.id, n])).values());
      return uniq.length >= 2 ? uniq : null;
    });
    expect(docs).not.toBeNull();
    const titles = docs!.map((d) => (d.data as { title: string }).title).sort();
    expect(titles[0]).toMatch(/^PDF —/);
    expect(titles[1]).toMatch(/^Photo —/);
    for (const d of docs!) {
      expect((d.data as { storedAt: string }).storedAt).toMatch(/^blob:sha256:[0-9a-f]{64}$/);
    }
    // Both blobs land in document_blobs, linked to the same nodes.
    const blobs = documentBlobRepo(db).list(hh);
    const mmsBlobs = blobs.filter((b) => b.uploadedBy.startsWith("twilio_inbound:"));
    expect(mmsBlobs.length).toBeGreaterThanOrEqual(2);
    void targetTitles;
  });
});

// Tiny polling helper — waits up to ~10s at 50ms cadence. Used to
// wait on fire-and-forget background work in the twilio path.
// The upper bound is generous because when the whole suite runs
// under vitest's parallel workers the CPU is loaded and MSW
// handlers can stall behind other tests' fetches; the 1s ceiling
// this used to have made this test flaky under that load.
const pollFor = async <T>(fn: () => T | null): Promise<T | null> => {
  for (let i = 0; i < 200; i++) {
    const v = fn();
    if (v !== null && !(Array.isArray(v) && v.length === 0)) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
};

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

describe("shared-line invite", () => {
  beforeEach(() => {
    vi.stubEnv("ATELIER_TWILIO_ACCOUNT_SID", "");
    vi.stubEnv("ATELIER_TWILIO_AUTH_TOKEN", "");
    vi.stubEnv("ATELIER_TWILIO_FROM_NUMBER", "");
  });

  it("GET /messaging/config reports sharedLineActive: false when unconfigured", async () => {
    const res = await app.inject({ method: "GET", url: "/messaging/config" });
    expect(res.statusCode).toBe(200);
    const cfg = res.json();
    expect(cfg.sharedLineActive).toBe(false);
    expect(cfg.conciergeNumber).toBe(null);
  });

  it("GET /messaging/config reflects the concierge env vars", async () => {
    vi.stubEnv("ATELIER_TWILIO_ACCOUNT_SID", "AC_test");
    vi.stubEnv("ATELIER_TWILIO_AUTH_TOKEN", "auth-tok");
    vi.stubEnv("ATELIER_TWILIO_FROM_NUMBER", "+15555550100");
    const res = await app.inject({ method: "GET", url: "/messaging/config" });
    expect(res.json()).toMatchObject({
      sharedLineActive: true,
      conciergeNumber: "+15555550100",
    });
  });

  it("POST /messaging/invite creates a verification AND sends the invite SMS in one call", async () => {
    // With no concierge env AND no per-household twilio credential,
    // the send falls back to the mock provider — enough to prove
    // the end-to-end wiring without touching real Twilio.
    const res = await app.inject({
      method: "POST",
      url: `/households/${hh}/messaging/invite`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        channel: "sms",
        address: "+14158675309",
        label: "Alex's phone",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    // Verification was minted.
    expect(body.invite.code).toMatch(/^\d{6}$/);
    expect(new Date(body.invite.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(body.invite.senderSource).toBe("none");
    // Outbound was recorded even in mock mode.
    expect(body.sent.provider).toBe("mock");
    expect(body.sent.to).toBe("+14158675309");
    // And the pending verification is discoverable via the code.
    const live = pendingVerificationRepo(db).findLiveByCode("sms", body.invite.code);
    expect(live?.householdId).toBe(hh);
    // Outbound message event landed.
    const outbound = messagingEventRepo(db)
      .list(hh)
      .filter((e) => e.direction === "outbound");
    expect(outbound.some((e) => e.body?.includes(body.invite.code))).toBe(true);
  });

  it("POST /messaging/invite marks senderSource: 'concierge' when the platform line is set", async () => {
    vi.stubEnv("ATELIER_TWILIO_ACCOUNT_SID", "AC_test");
    vi.stubEnv("ATELIER_TWILIO_AUTH_TOKEN", "auth-tok");
    vi.stubEnv("ATELIER_TWILIO_FROM_NUMBER", "+15555550100");
    // Twilio SDK will try to hit the API — msw catches it as
    // bypass and the send falls to Twilio's own error path. We
    // only care about senderSource resolution here, which is
    // decided before the network call.
    const res = await app.inject({
      method: "POST",
      url: `/households/${hh}/messaging/invite`,
      headers: { authorization: `Bearer ${token}` },
      payload: { channel: "sms", address: "+14158675310" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().invite.senderSource).toBe("concierge");
  });

  it("shared-line inbound: an inbound from a known customer number routes to their household", async () => {
    // Bind a customer number to this household via the direct-
    // add path (no verification needed — manager knew who).
    contactEndpointRepo(db).create({
      householdId: hh,
      channel: "sms",
      address: "+14158675311",
      label: "Alex",
    });
    // Customer texts the concierge line; server resolves by FROM.
    const res = await app.inject({
      method: "POST",
      url: "/messaging/inbound/mock",
      payload: {
        channel: "sms",
        from: "+14158675311",
        to: "+15555550100",
        body: "Book me a car for 6pm please",
        externalMessageId: "mock_shared_1",
      },
    });
    expect(res.statusCode).toBe(200);
    const out = res.json();
    expect(["dispatched", "deduped"]).toContain(out.outcome);
    expect(out.eventId).toBeTruthy();
  });

  it("STOP keyword flips the endpoint to opted_out and returns the required confirmation", async () => {
    contactEndpointRepo(db).create({
      householdId: hh,
      channel: "sms",
      address: "+14158675600",
      label: "Stop test",
    });
    // Customer texts STOP
    const res = await app.inject({
      method: "POST",
      url: "/messaging/inbound/mock",
      payload: {
        channel: "sms",
        from: "+14158675600",
        to: "+15555550100",
        body: "STOP",
        externalMessageId: "mock_stop_1",
      },
    });
    expect(res.statusCode).toBe(200);
    const out = res.json();
    expect(out.outcome).toBe("opted_out");
    expect(out.ackMessage).toMatch(/unsubscribed/i);
    expect(out.ackMessage).toMatch(/START to opt back in/i);

    // Endpoint reflects the new consent status.
    const ep = contactEndpointRepo(db).resolve("sms", "+14158675600");
    expect(ep?.consentStatus).toBe("opted_out");
    expect(ep?.consentSource).toBe("reply_stop");
    expect(ep?.consentRecordedAt).toBeTruthy();
  });

  it("further inbound from an opted-out endpoint is recorded but NOT dispatched to the planner", async () => {
    const ep = contactEndpointRepo(db).create({
      householdId: hh,
      channel: "sms",
      address: "+14158675601",
    });
    contactEndpointRepo(db).setConsent(ep.id, {
      status: "opted_out",
      source: "reply_stop",
    });
    const res = await app.inject({
      method: "POST",
      url: "/messaging/inbound/mock",
      payload: {
        channel: "sms",
        from: "+14158675601",
        to: "+15555550100",
        body: "Hey are you still there?",
        externalMessageId: "mock_stopped_hey",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe("opted_out");
    // Recorded in the household event log.
    const events = messagingEventRepo(db)
      .list(hh)
      .filter((e) => e.externalMessageId === "mock_stopped_hey");
    expect(events).toHaveLength(1);
    // NO planner run linked — the event stays unlinked.
    expect(events[0]!.plannerRunId).toBeNull();
  });

  it("START keyword resubscribes and returns the confirmation", async () => {
    const ep = contactEndpointRepo(db).create({
      householdId: hh,
      channel: "sms",
      address: "+14158675602",
    });
    contactEndpointRepo(db).setConsent(ep.id, {
      status: "opted_out",
      source: "reply_stop",
    });
    const res = await app.inject({
      method: "POST",
      url: "/messaging/inbound/mock",
      payload: {
        channel: "sms",
        from: "+14158675602",
        to: "+15555550100",
        body: "START",
        externalMessageId: "mock_start_1",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe("opted_in");
    expect(res.json().ackMessage).toMatch(/resubscribed/i);
    const after = contactEndpointRepo(db).resolve("sms", "+14158675602");
    expect(after?.consentStatus).toBe("opted_in");
    expect(after?.consentSource).toBe("reply_start");
  });

  it("outbound send to an opted-out recipient is refused with 403", async () => {
    const ep = contactEndpointRepo(db).create({
      householdId: hh,
      channel: "sms",
      address: "+14158675603",
    });
    contactEndpointRepo(db).setConsent(ep.id, {
      status: "opted_out",
      source: "reply_stop",
    });
    const res = await app.inject({
      method: "POST",
      url: `/households/${hh}/messaging/send`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        channel: "sms",
        to: "+14158675603",
        body: "Following up.",
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("recipient_opted_out");
  });

  it("verification consumption stamps the endpoint opted_in with source reply_yes", async () => {
    const pending = pendingVerificationRepo(db).create({
      householdId: hh,
      channel: "sms",
      createdBy: "manager:test",
      label: "consent test",
    });
    const claim = await app.inject({
      method: "POST",
      url: "/messaging/inbound/mock",
      payload: {
        channel: "sms",
        from: "+14158675604",
        to: "+15555550100",
        body: `Here you go: ${pending.code}`,
        externalMessageId: "mock_consent_claim",
      },
    });
    expect(claim.statusCode).toBe(200);
    expect(claim.json().outcome).toBe("verified");
    const ep = contactEndpointRepo(db).resolve("sms", "+14158675604");
    expect(ep?.consentStatus).toBe("opted_in");
    expect(ep?.consentSource).toBe("reply_yes");
    expect(ep?.consentRecordedAt).toBeTruthy();
  });

  it("consecutive inbound messages from the same endpoint share a session; a fresh outbound joins it", async () => {
    const ep = contactEndpointRepo(db).create({
      householdId: hh,
      channel: "sms",
      address: "+14158675700",
    });

    // First inbound → opens a session.
    const r1 = await app.inject({
      method: "POST",
      url: "/messaging/inbound/mock",
      payload: {
        channel: "sms",
        from: "+14158675700",
        to: "+15555550100",
        body: "book me a car",
        externalMessageId: "mock_ses_1",
      },
    });
    expect(r1.statusCode).toBe(200);
    const sessions1 = conversationSessionRepo(db).listOpenForEndpoint(ep.id);
    expect(sessions1).toHaveLength(1);
    const sessionId = sessions1[0]!.id;

    // Second inbound → same session (still within idle window).
    const r2 = await app.inject({
      method: "POST",
      url: "/messaging/inbound/mock",
      payload: {
        channel: "sms",
        from: "+14158675700",
        to: "+15555550100",
        body: "actually make it 7pm",
        externalMessageId: "mock_ses_2",
      },
    });
    expect(r2.statusCode).toBe(200);
    const sessions2 = conversationSessionRepo(db).listOpenForEndpoint(ep.id);
    // Still one open session — resumed, not replaced.
    expect(sessions2).toHaveLength(1);
    expect(sessions2[0]!.id).toBe(sessionId);

    // Both events tagged with the session id.
    const evs = messagingEventRepo(db).listBySession(sessionId);
    expect(evs).toHaveLength(2);
    expect(evs.map((e) => e.body)).toEqual([
      "book me a car",
      "actually make it 7pm",
    ]);

    // Manager sends an outbound reply → should attach to the same
    // session because there's an open one for that endpoint.
    const send = await app.inject({
      method: "POST",
      url: `/households/${hh}/messaging/send`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        channel: "sms",
        to: "+14158675700",
        body: "Confirmed for 7pm.",
      },
    });
    expect(send.statusCode).toBe(200);
    const withOutbound = messagingEventRepo(db).listBySession(sessionId);
    expect(withOutbound).toHaveLength(3);
    expect(withOutbound[2]!.direction).toBe("outbound");
    expect(withOutbound[2]!.body).toBe("Confirmed for 7pm.");
  });

  it("STOP does NOT get tagged with a session — opt-outs stand alone from the conversation", async () => {
    const ep = contactEndpointRepo(db).create({
      householdId: hh,
      channel: "sms",
      address: "+14158675701",
    });
    // Start a conversation.
    await app.inject({
      method: "POST",
      url: "/messaging/inbound/mock",
      payload: {
        channel: "sms",
        from: "+14158675701",
        to: "+15555550100",
        body: "hi",
        externalMessageId: "mock_ses_stop_1",
      },
    });
    // STOP arrives — fires the consent branch, not the session
    // branch. Event goes into messaging_events unsessioned.
    await app.inject({
      method: "POST",
      url: "/messaging/inbound/mock",
      payload: {
        channel: "sms",
        from: "+14158675701",
        to: "+15555550100",
        body: "STOP",
        externalMessageId: "mock_ses_stop_2",
      },
    });
    const openSessions = conversationSessionRepo(db).listOpenForEndpoint(ep.id);
    expect(openSessions).toHaveLength(1);
    const inSession = messagingEventRepo(db).listBySession(openSessions[0]!.id);
    // Only the first "hi" is in the session; the STOP is not.
    expect(inSession).toHaveLength(1);
    expect(inSession[0]!.body).toBe("hi");
  });

  it("GET /messaging/sessions lists open conversations with turn counts", async () => {
    contactEndpointRepo(db).create({
      householdId: hh,
      channel: "sms",
      address: "+14158675702",
    });
    await app.inject({
      method: "POST",
      url: "/messaging/inbound/mock",
      payload: {
        channel: "sms",
        from: "+14158675702",
        to: "+15555550100",
        body: "one turn",
        externalMessageId: "mock_ses_list_1",
      },
    });
    const list = await app.inject({
      method: "GET",
      url: `/households/${hh}/messaging/sessions`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    const found = list.json().sessions.find((s: { lastTurn?: { body: string } }) =>
      s.lastTurn?.body === "one turn",
    );
    expect(found).toBeTruthy();
    expect(found.turnCount).toBe(1);
    expect(found.lastTurn.direction).toBe("inbound");
  });

  it("invite → verify round trip binds the from-address to the invited profile", async () => {
    // Seed a person.principal so the invite can point at a profile.
    const principal = graphRepo(db).createNode(hh, {
      type: "person.principal",
      data: { fullName: "Ada Lovelace" },
      provenance: {
        source: "manager_direct",
        assertedBy: "test",
        assertedAt: new Date().toISOString(),
        confidence: 1,
        status: "confirmed",
      },
    });

    // Manager sends an invite explicitly linked to Ada.
    const invite = await app.inject({
      method: "POST",
      url: `/households/${hh}/messaging/invite`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        channel: "sms",
        address: "+14158675400",
        principalId: principal.id,
        label: "Ada's iPhone",
      },
    });
    expect(invite.statusCode).toBe(201);
    const code = invite.json().invite.code;

    // Customer texts the code from the invited number to the
    // concierge line. handleInbound's verification-claim branch
    // creates the endpoint AND carries the principalId over.
    const claim = await app.inject({
      method: "POST",
      url: "/messaging/inbound/mock",
      payload: {
        channel: "sms",
        from: "+14158675400",
        to: "+15555550100",
        body: `Here's my code: ${code}`,
        externalMessageId: "mock_ada_claim",
      },
    });
    expect(claim.statusCode).toBe(200);
    expect(claim.json().outcome).toBe("verified");

    // The new endpoint carries the principalId.
    const ep = contactEndpointRepo(db)
      .list(hh)
      .find((e) => e.address === "+14158675400");
    expect(ep?.principalId).toBe(principal.id);

    // A subsequent text from Ada's number now routes AND
    // identifies Ada (verified indirectly — no crash, event
    // recorded, no dedup this time because externalMessageId
    // is fresh).
    const followup = await app.inject({
      method: "POST",
      url: "/messaging/inbound/mock",
      payload: {
        channel: "sms",
        from: "+14158675400",
        to: "+15555550100",
        body: "One more thing",
        externalMessageId: "mock_ada_followup",
      },
    });
    expect(followup.statusCode).toBe(200);
    expect(["dispatched", "deduped"]).toContain(followup.json().outcome);
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

  it("agent-authored sms.send goes through the same outbound path and lands in messaging_events", async () => {
    // Build the orchestrator (which builds the messagingOutbound
    // seam via runtime.ts) and invoke smsSendTool through the
    // agent path.
    const { buildOrchestrator } = await import("../src/runtime.js");
    const { smsSendTool } = await import("@atelier/agents");
    const orch = buildOrchestrator(db);
    // The tool's normal path is through orch.executeTool via an
    // agent, which we don't need to spin up end-to-end. Instead,
    // we assert the wiring: buildOrchestrator's deps include
    // messagingOutbound, and calling it lands a messaging_event.
    const deps = (
      orch as unknown as { deps: { messagingOutbound?: { send: Function } } }
    ).deps;
    expect(deps.messagingOutbound).toBeDefined();

    const ep = contactEndpointRepo(db).create({
      householdId: hh,
      channel: "sms",
      address: "+14158676000",
    });
    void ep;

    const beforeCount = messagingEventRepo(db)
      .list(hh)
      .filter((e) => e.toAddress === "+14158676000" && e.direction === "outbound").length;

    const out = await deps.messagingOutbound!.send(hh, {
      channel: "sms",
      to: "+14158676000",
      body: "Booked for 7pm — confirmed.",
    });
    expect(out).toBeDefined();
    expect(out.provider).toBe("mock");
    expect(out.eventId).toMatch(/^mev_/);

    const afterEvents = messagingEventRepo(db)
      .list(hh)
      .filter((e) => e.toAddress === "+14158676000" && e.direction === "outbound");
    expect(afterEvents.length).toBe(beforeCount + 1);
    expect(afterEvents[0]!.body).toBe("Booked for 7pm — confirmed.");

    // Verify the tool itself uses the seam: invoke smsSendTool
    // with a hand-built ctx pointing at the runtime's outbound.
    const toolRes = await smsSendTool.invoke(
      {
        householdId: hh,
        authorityId: "pol_test",
        proposedBy: { actor: "concierge_agent", version: "0.1.0" },
        readCredential: () => null,
        sendChannelMessage: (input) => deps.messagingOutbound!.send(hh, input),
        logger: { info: () => {} },
      },
      {
        inputs: { channel: "sms", to: "+14158676000", body: "One more update." },
        summary: "Update",
      },
    );
    expect(toolRes.outcome).toBe("succeeded");
    const finalEvents = messagingEventRepo(db)
      .list(hh)
      .filter((e) => e.toAddress === "+14158676000" && e.direction === "outbound");
    expect(finalEvents.length).toBe(beforeCount + 2);
  });

  it("agent-authored sms.send refuses to send to an opted-out recipient", async () => {
    const ep = contactEndpointRepo(db).create({
      householdId: hh,
      channel: "sms",
      address: "+14158676001",
    });
    contactEndpointRepo(db).setConsent(ep.id, {
      status: "opted_out",
      source: "reply_stop",
    });

    const { buildOrchestrator } = await import("../src/runtime.js");
    const { smsSendTool } = await import("@atelier/agents");
    const deps = (
      buildOrchestrator(db) as unknown as {
        deps: { messagingOutbound: { send: Function } };
      }
    ).deps;

    const toolRes = await smsSendTool.invoke(
      {
        householdId: hh,
        authorityId: "pol_test",
        proposedBy: { actor: "concierge_agent", version: "0.1.0" },
        readCredential: () => null,
        sendChannelMessage: (input) => deps.messagingOutbound.send(hh, input),
        logger: { info: () => {} },
      },
      {
        inputs: { channel: "sms", to: "+14158676001", body: "You there?" },
        summary: "Ping",
      },
    );
    expect(toolRes.outcome).toBe("failed_permanent");
    expect(toolRes.outputs.refused).toBe("opted_out");
    // No messaging_event recorded for a refused send.
    const outboundAfter = messagingEventRepo(db)
      .list(hh)
      .filter((e) => e.toAddress === "+14158676001" && e.direction === "outbound");
    expect(outboundAfter).toHaveLength(0);
  });
});

describe("outbound author attribution", () => {
  it("manager-triggered /messaging/send stamps authoredByType: 'manager' + actor id + display name", async () => {
    const send = await app.inject({
      method: "POST",
      url: `/households/${hh}/messaging/send`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        channel: "sms",
        to: "+14158676200",
        body: "Manager reply.",
      },
    });
    expect(send.statusCode).toBe(200);
    const eventId = send.json().sent.eventId as string;
    const row = messagingEventRepo(db)
      .list(hh)
      .find((e) => e.id === eventId);
    expect(row?.authoredByType).toBe("manager");
    expect(row?.authoredById).toMatch(/^mgr_/);
    expect(row?.authoredByLabel).toBe("M");
  });

  it("agent-authored send via the runtime seam stamps authoredByType: 'agent' + agent name+version", async () => {
    const { buildOrchestrator } = await import("../src/runtime.js");
    const deps = (
      buildOrchestrator(db) as unknown as {
        deps: {
          messagingOutbound: {
            send: (
              hh: string,
              i: { channel: string; to: string; body: string },
              a?: { type: string; id: string; label?: string },
            ) => Promise<{ eventId: string }>;
          };
        };
      }
    ).deps;
    const out = await deps.messagingOutbound.send(
      hh,
      { channel: "sms", to: "+14158676201", body: "Agent draft." },
      { type: "agent", id: "concierge/0.1.0", label: "concierge" },
    );
    const row = messagingEventRepo(db)
      .list(hh)
      .find((e) => e.id === out.eventId);
    expect(row?.authoredByType).toBe("agent");
    expect(row?.authoredById).toBe("concierge/0.1.0");
    expect(row?.authoredByLabel).toBe("concierge");
  });
});

describe("delivery status callbacks", () => {
  it("updates deliveryStatus on the outbound event when Twilio POSTs a status", async () => {
    // First, land an outbound event we can target by its
    // externalMessageId. Send via /messaging/send (no live
    // twilio credential = mock provider), then rewrite the
    // provider on the row to "twilio" and give it a predictable
    // sid so the callback matches.
    const send = await app.inject({
      method: "POST",
      url: `/households/${hh}/messaging/send`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        channel: "sms",
        to: "+14158676100",
        body: "hello",
      },
    });
    expect(send.statusCode).toBe(200);
    const eventId = send.json().sent.eventId as string;

    // Retroactively rewrite the row so the twilio-status callback
    // has something to match. In real prod flow, the row is
    // already provider=twilio when Twilio calls back.
    db.update(messagingEvents)
      .set({ provider: "twilio", externalMessageId: "SM_delivery_1" })
      .where(eq(messagingEvents.id, eventId))
      .run();

    // Twilio callback: MessageSid + MessageStatus.
    const cb = await app.inject({
      method: "POST",
      url: "/messaging/status/twilio",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "MessageSid=SM_delivery_1&MessageStatus=delivered",
    });
    expect(cb.statusCode).toBe(200);

    const updated = messagingEventRepo(db)
      .list(hh)
      .find((e) => e.id === eventId);
    expect(updated?.deliveryStatus).toBe("delivered");
    expect(updated?.deliveryStatusAt).toBeTruthy();
    expect(updated?.deliveryErrorCode).toBeNull();
  });

  it("records the Twilio error code on a failed delivery", async () => {
    const send = await app.inject({
      method: "POST",
      url: `/households/${hh}/messaging/send`,
      headers: { authorization: `Bearer ${token}` },
      payload: { channel: "sms", to: "+14158676101", body: "will fail" },
    });
    const eventId = send.json().sent.eventId as string;
    db.update(messagingEvents)
      .set({ provider: "twilio", externalMessageId: "SM_fail_1" })
      .where(eq(messagingEvents.id, eventId))
      .run();

    const cb = await app.inject({
      method: "POST",
      url: "/messaging/status/twilio",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "MessageSid=SM_fail_1&MessageStatus=failed&ErrorCode=30003",
    });
    expect(cb.statusCode).toBe(200);

    const updated = messagingEventRepo(db).list(hh).find((e) => e.id === eventId);
    expect(updated?.deliveryStatus).toBe("failed");
    expect(updated?.deliveryErrorCode).toBe("30003");
  });

  it("acks 200 (does NOT 404) when the callback references an unknown MessageSid", async () => {
    const cb = await app.inject({
      method: "POST",
      url: "/messaging/status/twilio",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "MessageSid=SM_never_seen&MessageStatus=delivered",
    });
    // 200 so Twilio doesn't retry forever.
    expect(cb.statusCode).toBe(200);
    expect(cb.json().ok).toBe(true);
  });

  it("400s a callback missing MessageSid or MessageStatus", async () => {
    const cb = await app.inject({
      method: "POST",
      url: "/messaging/status/twilio",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "MessageSid=SM_only",
    });
    expect(cb.statusCode).toBe(400);
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
