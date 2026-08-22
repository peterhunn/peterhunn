import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { syncGmailInbox, type GmailSyncCursor } from "../src/tools/gmail-sync.js";
import type { HouseholdId } from "@atelier/domain";
import type { StoredCredential } from "../src/types.js";

// MSW-based tests. Intercepts at the socket level so gaxios (the
// transport googleapis uses) hits our mocked responses without any
// stubbing of fetch. Each test adds its own handlers via
// server.use(); unhandled requests fail loudly so a missed URL
// surfaces as a test failure instead of a silent live call.

const GMAIL = "https://gmail.googleapis.com/gmail/v1";
const HH = "hh_test" as HouseholdId;

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeEach(() => {
  // no-op — handlers scoped per test.
});

const b64url = (s: string): string =>
  Buffer.from(s, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const mkCtx = (credential: Record<string, unknown> | null) => ({
  householdId: HH,
  readCredential: (provider: string) => {
    if (provider !== "gmail" || !credential) return null;
    return {
      id: "crd_test",
      credential,
      expiresAt: null,
    } satisfies StoredCredential;
  },
  logger: { info: () => {} },
});

interface UpsertCall {
  externalMessageId: string;
  fromName: string;
  fromAddress: string;
  subject: string;
  body: string;
}

const mkSink = (existing: Set<string> = new Set()) => {
  const calls: UpsertCall[] = [];
  return {
    calls,
    upsertMessage: (i: UpsertCall & Record<string, unknown>) => {
      calls.push({
        externalMessageId: i.externalMessageId,
        fromName: i.fromName,
        fromAddress: i.fromAddress,
        subject: i.subject,
        body: i.body,
      });
      const seen = existing.has(i.externalMessageId);
      existing.add(i.externalMessageId);
      return { inserted: !seen };
    },
  };
};

describe("syncGmailInbox", () => {
  it("returns consulted:false when the household has not connected Gmail", async () => {
    const sink = mkSink();
    const res = await syncGmailInbox(mkCtx(null), sink);
    expect(res.consulted).toBe(false);
    expect(sink.calls).toHaveLength(0);
  });

  it("lists unread messages, fetches each one, and upserts to the sink", async () => {
    server.use(
      http.get(`${GMAIL}/users/me/messages`, () =>
        HttpResponse.json({
          messages: [
            { id: "gm_1", threadId: "t_1" },
            { id: "gm_2", threadId: "t_2" },
          ],
        }),
      ),
      http.get(`${GMAIL}/users/me/messages/gm_1`, () =>
        HttpResponse.json({
          id: "gm_1",
          threadId: "t_1",
          internalDate: String(Date.UTC(2026, 8, 1, 15, 0, 0)),
          payload: {
            headers: [
              { name: "From", value: '"Sam Rodriguez" <sam@example.com>' },
              { name: "Subject", value: "Quote for fence repair" },
              { name: "Date", value: "Tue, 01 Sep 2026 15:00:00 +0000" },
            ],
            mimeType: "text/plain",
            body: { data: b64url("Estimate is $1,850. Please confirm by Friday.") },
          },
        }),
      ),
      http.get(`${GMAIL}/users/me/messages/gm_2`, () =>
        HttpResponse.json({
          id: "gm_2",
          threadId: "t_2",
          internalDate: String(Date.UTC(2026, 8, 1, 16, 0, 0)),
          payload: {
            headers: [
              { name: "From", value: "office@ridgeschool.example" },
              { name: "Subject", value: "Field trip form" },
              { name: "Date", value: "Tue, 01 Sep 2026 16:00:00 +0000" },
            ],
            mimeType: "multipart/alternative",
            parts: [
              {
                mimeType: "text/html",
                body: { data: b64url("<html><body><p>Please sign & return.</p></body></html>") },
              },
              { mimeType: "text/plain", body: { data: b64url("Please sign & return.") } },
            ],
          },
        }),
      ),
    );
    const sink = mkSink();
    const res = await syncGmailInbox(
      mkCtx({ access_token: "at-abc", from_address: "alex@atelier.example" }),
      sink,
    );
    expect(res.consulted).toBe(true);
    expect(res.listed).toBe(2);
    expect(res.fetched).toBe(2);
    expect(res.inserted).toBe(2);
    expect(sink.calls[0]!.fromName).toBe("Sam Rodriguez");
    expect(sink.calls[0]!.fromAddress).toBe("sam@example.com");
    expect(sink.calls[0]!.body).toContain("$1,850");
    expect(sink.calls[1]!.fromAddress).toBe("office@ridgeschool.example");
    expect(sink.calls[1]!.body).toBe("Please sign & return.");
  });

  it("counts dedupe skips returned by the sink", async () => {
    server.use(
      http.get(`${GMAIL}/users/me/messages`, () =>
        HttpResponse.json({ messages: [{ id: "dup_1" }] }),
      ),
      http.get(`${GMAIL}/users/me/messages/dup_1`, () =>
        HttpResponse.json({
          id: "dup_1",
          payload: {
            headers: [
              { name: "From", value: "a@b.com" },
              { name: "Subject", value: "hi" },
            ],
            mimeType: "text/plain",
            body: { data: b64url("body") },
          },
        }),
      ),
    );
    const sink = mkSink(new Set(["dup_1"]));
    const res = await syncGmailInbox(mkCtx({ access_token: "at-abc" }), sink);
    expect(res.inserted).toBe(0);
    expect(res.skippedDuplicates).toBe(1);
  });

  it("returns an error field when the list endpoint returns non-2xx", async () => {
    server.use(
      http.get(`${GMAIL}/users/me/messages`, () =>
        HttpResponse.text("nope", { status: 500 }),
      ),
    );
    const res = await syncGmailInbox(mkCtx({ access_token: "at-abc" }), mkSink());
    expect(res.consulted).toBe(true);
    expect(res.error).toContain("gmail_list_500");
    expect(res.inserted).toBe(0);
  });

  it("saves a historyId cursor on the first full pull", async () => {
    server.use(
      http.get(`${GMAIL}/users/me/messages`, () =>
        HttpResponse.json({ messages: [{ id: "gm_A" }] }),
      ),
      http.get(`${GMAIL}/users/me/messages/gm_A`, () =>
        HttpResponse.json({
          id: "gm_A",
          historyId: "1000",
          payload: {
            headers: [
              { name: "From", value: "a@b.com" },
              { name: "Subject", value: "hi" },
            ],
            mimeType: "text/plain",
            body: { data: b64url("body") },
          },
        }),
      ),
    );
    const saved: Array<{ cursor: { historyId?: string } }> = [];
    const cursor: GmailSyncCursor = {
      read: () => null,
      save: (_h, _p, c) => saved.push({ cursor: c }),
      clear: () => {},
    };
    const res = await syncGmailInbox(mkCtx({ access_token: "at" }), mkSink(), {
      cursorStore: cursor,
    });
    expect(res.mode).toBe("full");
    expect(res.historyId).toBe("1000");
    expect(saved).toHaveLength(1);
    expect(saved[0]!.cursor.historyId).toBe("1000");
  });

  it("uses the History API when a cursor exists and only fetches added INBOX messages", async () => {
    let historyCalls = 0;
    let listCalls = 0;
    server.use(
      http.get(`${GMAIL}/users/me/history`, ({ request }) => {
        historyCalls++;
        const url = new URL(request.url);
        expect(url.searchParams.get("startHistoryId")).toBe("1000");
        expect(url.searchParams.getAll("historyTypes")).toContain("messageAdded");
        return HttpResponse.json({
          historyId: "1050",
          history: [
            {
              id: "1010",
              messagesAdded: [
                { message: { id: "gm_new", threadId: "t_new", labelIds: ["INBOX", "UNREAD"] } },
              ],
            },
            {
              // sent-only mail — no INBOX label; must be ignored.
              id: "1020",
              messagesAdded: [
                { message: { id: "gm_sent", threadId: "t_sent", labelIds: ["SENT"] } },
              ],
            },
          ],
        });
      }),
      http.get(`${GMAIL}/users/me/messages`, () => {
        listCalls++;
        return HttpResponse.text("shouldn't hit list on incremental", { status: 500 });
      }),
      http.get(`${GMAIL}/users/me/messages/gm_new`, () =>
        HttpResponse.json({
          id: "gm_new",
          historyId: "1040",
          payload: {
            headers: [
              { name: "From", value: "sam@example.com" },
              { name: "Subject", value: "Fresh" },
            ],
            mimeType: "text/plain",
            body: { data: b64url("just landed") },
          },
        }),
      ),
    );
    const saved: Array<{ cursor: { historyId?: string } }> = [];
    const cursor: GmailSyncCursor = {
      read: () => ({ historyId: "1000" }),
      save: (_h, _p, c) => saved.push({ cursor: c }),
      clear: () => {},
    };
    const sink = mkSink();
    const res = await syncGmailInbox(mkCtx({ access_token: "at" }), sink, {
      cursorStore: cursor,
    });
    expect(historyCalls).toBe(1);
    expect(listCalls).toBe(0);
    expect(res.mode).toBe("incremental");
    expect(res.listed).toBe(1);
    expect(res.inserted).toBe(1);
    expect(sink.calls[0]!.externalMessageId).toBe("gm_new");
    // Advances to the max of history.historyId and the message's historyId.
    expect(saved[0]!.cursor.historyId).toBe("1050");
  });

  it("returns up_to_date when the history API returns no messagesAdded", async () => {
    server.use(
      http.get(`${GMAIL}/users/me/history`, () =>
        HttpResponse.json({ historyId: "2000", history: [] }),
      ),
    );
    const saved: Array<{ cursor: { historyId?: string } }> = [];
    const cursor: GmailSyncCursor = {
      read: () => ({ historyId: "1500" }),
      save: (_h, _p, c) => saved.push({ cursor: c }),
      clear: () => {},
    };
    const res = await syncGmailInbox(mkCtx({ access_token: "at" }), mkSink(), {
      cursorStore: cursor,
    });
    expect(res.mode).toBe("up_to_date");
    expect(res.inserted).toBe(0);
    expect(saved[0]!.cursor.historyId).toBe("2000");
  });

  it("resets the cursor and falls back to a full pull on history 404", async () => {
    let cleared = false;
    server.use(
      http.get(`${GMAIL}/users/me/history`, () =>
        HttpResponse.text("cursor too old", { status: 404 }),
      ),
      http.get(`${GMAIL}/users/me/messages`, () =>
        HttpResponse.json({ messages: [{ id: "gm_R" }] }),
      ),
      http.get(`${GMAIL}/users/me/messages/gm_R`, () =>
        HttpResponse.json({
          id: "gm_R",
          historyId: "9000",
          payload: {
            headers: [
              { name: "From", value: "a@b.com" },
              { name: "Subject", value: "R" },
            ],
            mimeType: "text/plain",
            body: { data: b64url("R body") },
          },
        }),
      ),
    );
    const cursor: GmailSyncCursor = {
      read: () => ({ historyId: "1" }),
      save: () => {},
      clear: () => {
        cleared = true;
      },
    };
    const res = await syncGmailInbox(mkCtx({ access_token: "at" }), mkSink(), {
      cursorStore: cursor,
    });
    expect(cleared).toBe(true);
    expect(res.mode).toBe("cursor_reset");
    expect(res.inserted).toBe(1);
  });

  it("skips a single message when its detail fetch errors, keeps going with the rest", async () => {
    server.use(
      http.get(`${GMAIL}/users/me/messages`, () =>
        HttpResponse.json({ messages: [{ id: "ok_1" }, { id: "bad_2" }] }),
      ),
      http.get(`${GMAIL}/users/me/messages/ok_1`, () =>
        HttpResponse.json({
          id: "ok_1",
          payload: {
            headers: [
              { name: "From", value: "a@b.com" },
              { name: "Subject", value: "hi" },
            ],
            mimeType: "text/plain",
            body: { data: b64url("ok body") },
          },
        }),
      ),
      http.get(`${GMAIL}/users/me/messages/bad_2`, () =>
        HttpResponse.text("nope", { status: 500 }),
      ),
    );
    const sink = mkSink();
    const res = await syncGmailInbox(mkCtx({ access_token: "at-abc" }), sink);
    expect(res.listed).toBe(2);
    expect(res.fetched).toBe(1);
    expect(res.inserted).toBe(1);
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]!.externalMessageId).toBe("ok_1");
  });
});
