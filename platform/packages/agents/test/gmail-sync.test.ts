import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { syncGmailInbox } from "../src/tools/gmail-sync.js";
import type { HouseholdId } from "@atelier/domain";
import type { StoredCredential } from "../src/types.js";

const HH = "hh_test" as HouseholdId;

const stubFetch = (impl: (url: string, init?: RequestInit) => Response) => {
  vi.stubGlobal("fetch", vi.fn(async (u: string, i?: RequestInit) => impl(u, i)));
};

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

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("syncGmailInbox", () => {
  it("returns consulted:false when the household has not connected Gmail", async () => {
    const sink = mkSink();
    const res = await syncGmailInbox(mkCtx(null), sink);
    expect(res.consulted).toBe(false);
    expect(sink.calls).toHaveLength(0);
  });

  it("lists unread messages, fetches each one, and upserts to the sink", async () => {
    stubFetch((url) => {
      if (url.includes("/users/me/messages?q=")) {
        return new Response(
          JSON.stringify({
            messages: [
              { id: "gm_1", threadId: "t_1" },
              { id: "gm_2", threadId: "t_2" },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/users/me/messages/gm_1")) {
        return new Response(
          JSON.stringify({
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
          { status: 200 },
        );
      }
      if (url.includes("/users/me/messages/gm_2")) {
        return new Response(
          JSON.stringify({
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
                {
                  mimeType: "text/plain",
                  body: { data: b64url("Please sign & return.") },
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
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
    stubFetch((url) => {
      if (url.includes("/users/me/messages?q=")) {
        return new Response(JSON.stringify({ messages: [{ id: "dup_1" }] }), { status: 200 });
      }
      if (url.includes("/users/me/messages/dup_1")) {
        return new Response(
          JSON.stringify({
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
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const sink = mkSink(new Set(["dup_1"]));
    const res = await syncGmailInbox(
      mkCtx({ access_token: "at-abc" }),
      sink,
    );
    expect(res.inserted).toBe(0);
    expect(res.skippedDuplicates).toBe(1);
  });

  it("returns an error field when the list endpoint returns non-2xx", async () => {
    stubFetch(() => new Response("nope", { status: 500 }));
    const res = await syncGmailInbox(mkCtx({ access_token: "at-abc" }), mkSink());
    expect(res.consulted).toBe(true);
    expect(res.error).toContain("gmail_list_500");
    expect(res.inserted).toBe(0);
  });

  it("skips a single message when its detail fetch errors, keeps going with the rest", async () => {
    stubFetch((url) => {
      if (url.includes("/users/me/messages?q=")) {
        return new Response(
          JSON.stringify({ messages: [{ id: "ok_1" }, { id: "bad_2" }] }),
          { status: 200 },
        );
      }
      if (url.includes("/users/me/messages/ok_1")) {
        return new Response(
          JSON.stringify({
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
          { status: 200 },
        );
      }
      // bad_2 fails
      return new Response("nope", { status: 500 });
    });
    const sink = mkSink();
    const res = await syncGmailInbox(mkCtx({ access_token: "at-abc" }), sink);
    expect(res.listed).toBe(2);
    expect(res.fetched).toBe(1);
    expect(res.inserted).toBe(1);
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]!.externalMessageId).toBe("ok_1");
  });
});
