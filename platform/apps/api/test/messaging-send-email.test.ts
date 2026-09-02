import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  openDb,
  credentialRepo,
  householdRepo,
  identityRepo,
  inboxRepo,
} from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";
import { buildServer } from "../src/server.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let db: ReturnType<typeof openDb>;
let token: string;
let hh: HouseholdId;

const server = setupServer();

beforeAll(async () => {
  db = openDb({ url: ":memory:" });
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: "../../packages/db/migrations" });

  const identity = identityRepo(db);
  const m = identity.createManager({ displayName: "Manager Alex", email: "m@a.b" });
  token = identity.mintToken({
    actorType: "manager",
    actorId: m.id,
    label: "t",
  }).token;
  hh = householdRepo(db).create({ name: "H", tier: "life" }).id;
  identity.grantHousehold({ managerId: m.id, householdId: hh, role: "primary" });

  app = buildServer(db);
  await app.ready();
  server.listen({ onUnhandledRequest: "bypass" });
});

afterAll(async () => {
  server.close();
  await app.close();
});

beforeEach(() => server.resetHandlers());
afterEach(() => server.resetHandlers());

describe("POST /households/:id/messaging/send-email", () => {
  it("400s when the household has no gmail credential", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/households/${hh}/messaging/send-email`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        toName: "Sam",
        toAddress: "sam@example.com",
        subject: "Re: dinner",
        body: "See you at 7.",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("gmail_not_connected");
  });

  it("sends via Gmail and records an outbound row in inbox_messages", async () => {
    credentialRepo(db).store({
      householdId: hh,
      provider: "gmail",
      kind: "oauth2",
      label: "Gmail",
      credential: {
        access_token: "at-live",
        from_address: "household@atelier.example",
      },
    });

    server.use(
      http.post(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        async () =>
          HttpResponse.json({
            id: "gmail_id_1",
            threadId: "thread_1",
            labelIds: ["SENT"],
          }),
      ),
    );

    const res = await app.inject({
      method: "POST",
      url: `/households/${hh}/messaging/send-email`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        toName: "Sam",
        toAddress: "sam@example.com",
        subject: "Re: dinner",
        body: "See you at 7. Wine bar on 5th.",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sent.provider).toBe("gmail");
    expect(body.sent.sentMessageId).toBe("gmail_id_1");
    expect(body.sent.threadId).toBe("thread_1");
    expect(body.sent.from).toBe("household@atelier.example");

    // Row lands on inbox_messages with direction=outbound so the
    // per-customer timeline picks it up before the next SENT sync.
    const inboxRow = inboxRepo(db).get(body.sent.inboxMessageId);
    expect(inboxRow).not.toBeNull();
    expect(inboxRow!.direction).toBe("outbound");
    expect(inboxRow!.fromAddress).toBe("household@atelier.example");
    expect(inboxRow!.toAddress).toBe("sam@example.com");
    expect(inboxRow!.subject).toBe("Re: dinner");
    expect(inboxRow!.body).toContain("Wine bar");
    expect(inboxRow!.externalMessageId).toBe("gmail_id_1");
    expect(inboxRow!.externalThreadId).toBe("thread_1");
    // A freshly generated Message-ID is persisted so a customer's
    // reply — arriving inbound with In-Reply-To = this header — can
    // be threaded back to the outbound row we just recorded.
    expect(inboxRow!.messageIdHeader).toBeTruthy();
    expect(inboxRow!.messageIdHeader).toContain("@atelier.example");
  });

  it("threads the reply — passes threadId to Gmail and stamps In-Reply-To / References onto the RFC-822 body", async () => {
    // Credential already stored above. Capture the outbound
    // request so we can assert the raw RFC-822 headers and the
    // threadId that Gmail sees.
    const captured: {
      body?: { raw?: string; threadId?: string };
      raw?: string;
    } = {};
    server.use(
      http.post(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        async ({ request }) => {
          captured.body = (await request.json()) as {
            raw?: string;
            threadId?: string;
          };
          const rawB64 = captured.body?.raw ?? "";
          // Gmail expects base64url (no padding); decode to inspect.
          const b = Buffer.from(
            rawB64.replace(/-/g, "+").replace(/_/g, "/") +
              "==".slice(0, (4 - (rawB64.length % 4)) % 4),
            "base64",
          );
          captured.raw = b.toString("utf-8");
          return HttpResponse.json({
            id: "gmail_id_2",
            threadId: "thread_1",
          });
        },
      ),
    );

    const res = await app.inject({
      method: "POST",
      url: `/households/${hh}/messaging/send-email`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        toName: "Sam",
        toAddress: "sam@example.com",
        subject: "Re: dinner",
        body: "See you at 8.",
        inReplyToRef: "orig-123@example.com",
        threadId: "thread_1",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sent.sentMessageId).toBe("gmail_id_2");
    expect(body.sent.threadId).toBe("thread_1");

    // Gmail received threadId server-side.
    expect(captured.body?.threadId).toBe("thread_1");

    // RFC-822 headers pass through so non-Gmail MUAs also thread.
    expect(captured.raw).toContain("In-Reply-To: <orig-123@example.com>");
    expect(captured.raw).toContain("References: <orig-123@example.com>");
    // Every outbound gets a fresh Message-ID header on the wire.
    expect(captured.raw).toMatch(/Message-ID: <[^>]+@atelier\.example>/);
  });
});
