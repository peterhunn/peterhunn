import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  openDb,
  credentialRepo,
  householdRepo,
  identityRepo,
} from "@atelier/db";
import type { HouseholdId } from "@atelier/domain";
import { buildServer } from "../src/server.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let db: ReturnType<typeof openDb>;
let token: string;
let hh: HouseholdId;

const b64url = (s: string): string =>
  Buffer.from(s, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

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

  app = buildServer(db);
  await app.ready();
});

afterAll(async () => {
  server.close();
  await app.close();
});

// The Gmail sync path uses @googleapis/gmail (gaxios under the
// hood), not global fetch, so vi.stubGlobal("fetch") never sees
// its calls. MSW intercepts at the socket layer for both.
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
beforeEach(() => server.resetHandlers());
afterEach(() => server.resetHandlers());

describe("Gmail inbox sync API", () => {
  it("400s when the household has no gmail credential", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/households/${hh}/inbox/sync`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("gmail_not_connected");
  });

  it("syncs unread Gmail into the inbox_messages table and dedupes on re-run", async () => {
    // Store a gmail credential for the household.
    credentialRepo(db).store({
      householdId: hh,
      provider: "gmail",
      kind: "oauth2",
      label: "Gmail (test)",
      credential: {
        access_token: "at-live",
        from_address: "alex@atelier.example",
      },
    });

    server.use(
      http.get(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        () =>
          HttpResponse.json({
            messages: [{ id: "gm_sync_1" }],
            resultSizeEstimate: 1,
          }),
      ),
      http.get(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/gm_sync_1",
        () =>
          HttpResponse.json({
            id: "gm_sync_1",
            threadId: "t1",
            internalDate: String(Date.UTC(2026, 8, 1, 15, 0, 0)),
            payload: {
              headers: [
                { name: "From", value: '"Sam" <sam@example.com>' },
                { name: "Subject", value: "Estimate" },
                { name: "Message-ID", value: "<sam-original-msg-id@example.com>" },
              ],
              mimeType: "text/plain",
              body: { data: b64url("$1,850. Confirm by Friday.") },
            },
          }),
      ),
    );

    const first = await app.inject({
      method: "POST",
      url: `/households/${hh}/inbox/sync`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(first.statusCode).toBe(200);
    const firstResult = first.json().sync;
    expect(firstResult.listed).toBe(1);
    expect(firstResult.inserted).toBe(1);
    expect(firstResult.skippedDuplicates).toBe(0);

    // Inbox now carries the new message.
    const inbox = await app.inject({
      method: "GET",
      url: `/households/${hh}/inbox`,
      headers: { authorization: `Bearer ${token}` },
    });
    const list: Array<{
      externalMessageId: string | null;
      subject: string;
      body: string;
      fromAddress: string;
      messageIdHeader: string | null;
    }> = inbox.json().messages;
    const synced = list.find((m) => m.externalMessageId === "gm_sync_1");
    expect(synced).toBeDefined();
    expect(synced!.subject).toBe("Estimate");
    expect(synced!.fromAddress).toBe("sam@example.com");
    expect(synced!.body).toContain("$1,850");
    // Message-ID header extracted, angle brackets stripped — the
    // form the composer feeds back into a reply's inReplyToRef.
    expect(synced!.messageIdHeader).toBe("sam-original-msg-id@example.com");

    // Re-run: the incremental cursor now points at the historyId
    // recorded above. Empty history → dedupe → 0 inserted.
    server.use(
      http.get(
        "https://gmail.googleapis.com/gmail/v1/users/me/history",
        () => HttpResponse.json({ historyId: "1000" }),
      ),
    );
    const second = await app.inject({
      method: "POST",
      url: `/households/${hh}/inbox/sync`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    const secondResult = second.json().sync;
    expect(secondResult.inserted).toBe(0);
  });

  it("syncs the SENT mailbox with mailbox='sent', persists to_address + direction=outbound", async () => {
    // Same credential + household already stored above. SENT sync
    // stores its own history cursor under provider=gmail_sent, so
    // the mock only needs to answer the "full pull" path.
    server.use(
      http.get(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        () =>
          HttpResponse.json({
            messages: [{ id: "gm_sent_1" }],
            resultSizeEstimate: 1,
          }),
      ),
      http.get(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/gm_sent_1",
        () =>
          HttpResponse.json({
            id: "gm_sent_1",
            threadId: "t_sent_1",
            internalDate: String(Date.UTC(2026, 8, 2, 10, 0, 0)),
            labelIds: ["SENT"],
            payload: {
              headers: [
                { name: "From", value: '"Household" <household@atelier.example>' },
                { name: "To", value: '"Sam" <sam@example.com>' },
                { name: "Subject", value: "Re: Estimate" },
              ],
              mimeType: "text/plain",
              body: { data: b64url("Thanks Sam — will confirm today.") },
            },
          }),
      ),
    );

    const res = await app.inject({
      method: "POST",
      url: `/households/${hh}/inbox/sync`,
      headers: { authorization: `Bearer ${token}` },
      payload: { mailbox: "sent" },
    });
    expect(res.statusCode).toBe(200);
    const sync = res.json().sync;
    expect(sync.listed).toBe(1);
    expect(sync.inserted).toBe(1);

    // The sent row lands in inbox_messages with direction=outbound
    // and toAddress populated. The inbox listing returns both.
    const list = await app.inject({
      method: "GET",
      url: `/households/${hh}/inbox`,
      headers: { authorization: `Bearer ${token}` },
    });
    const messages: Array<{
      externalMessageId: string | null;
      direction: string;
      fromAddress: string;
      toAddress: string | null;
      subject: string;
    }> = list.json().messages;
    const sent = messages.find((m) => m.externalMessageId === "gm_sent_1");
    expect(sent).toBeDefined();
    expect(sent!.direction).toBe("outbound");
    expect(sent!.fromAddress).toBe("household@atelier.example");
    expect(sent!.toAddress).toBe("sam@example.com");
  });

  it("mailbox='both' runs inbox + sent back to back and returns per-mailbox results", async () => {
    // Fresh household — otherwise the earlier tests' history
    // cursors would flip the mode to incremental.
    server.use(
      http.get(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        () =>
          HttpResponse.json({ messages: [], resultSizeEstimate: 0 }),
      ),
    );

    const res = await app.inject({
      method: "POST",
      url: `/households/${hh}/inbox/sync`,
      headers: { authorization: `Bearer ${token}` },
      payload: { mailbox: "both" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      mailboxes: Array<{
        mailbox: "inbox" | "sent";
        result: { mode: string; consulted: boolean };
      }>;
    };
    expect(body.mailboxes.map((m) => m.mailbox)).toEqual(["inbox", "sent"]);
    for (const m of body.mailboxes) {
      expect(m.result.consulted).toBe(true);
    }
  });
});
