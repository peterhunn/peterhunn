import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { messageSendTool } from "../src/tools/message.js";
import type { HouseholdId } from "@atelier/domain";
import type { StoredCredential, ToolContext } from "../src/types.js";

const HH = "hh_test" as HouseholdId;

const stubFetch = (impl: (url: string, init?: RequestInit) => Response) => {
  vi.stubGlobal("fetch", vi.fn(async (u: string, i?: RequestInit) => impl(u, i)));
};

const mkCtx = (
  credential: Record<string, unknown> | null,
  expiresAt: string | null = null,
): ToolContext => ({
  householdId: HH,
  authorityId: "pol_test",
  proposedBy: { actor: "inbox_agent", version: "0.1.0" },
  readCredential: (provider) => {
    if (provider !== "gmail" || !credential) return null;
    return {
      id: "crd_test",
      credential,
      expiresAt,
    } satisfies StoredCredential;
  },
  logger: { info: () => {} },
});

const baseInputs = {
  toName: "Sam Rodriguez",
  toAddress: "sam@example.com",
  subject: "Re: Quote for fence repair",
  body: "Thanks Sam — confirming Tuesday.",
  attendees: [],
};

const base64UrlDecode = (s: string): string => {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (s.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf-8");
};

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("message.send", () => {
  it("falls back to mock when no gmail credential is stored", async () => {
    stubFetch(() => new Response("network disabled", { status: 500 }));
    const res = await messageSendTool.invoke(mkCtx(null), {
      inputs: baseInputs,
      summary: "Send reply",
    });
    expect(res.outcome).toBe("succeeded");
    expect(res.outputs.provider).toBe("mock");
    expect(res.outputs.sentMessageId.startsWith("mock-sent-")).toBe(true);
  });

  it("POSTs a base64url-encoded RFC-822 message to Gmail when a credential is present", async () => {
    let capturedRaw: string | null = null;
    stubFetch((url, init) => {
      expect(url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer live-token");
      const body = JSON.parse(String(init?.body ?? "{}")) as { raw?: string };
      expect(typeof body.raw).toBe("string");
      capturedRaw = base64UrlDecode(body.raw!);
      return new Response(
        JSON.stringify({ id: "gm_msg_123", threadId: "gm_thread_1" }),
        { status: 200 },
      );
    });

    const res = await messageSendTool.invoke(
      mkCtx({
        access_token: "live-token",
        from_address: "alex@atelier.example",
        from_name: "Atelier — Alex's office",
      }),
      { inputs: baseInputs, summary: "Send reply" },
    );

    expect(res.outputs.provider).toBe("gmail");
    expect(res.outputs.sentMessageId).toBe("gm_msg_123");
    expect(res.outputs.threadId).toBe("gm_thread_1");

    // Verify the RFC-822 body was assembled correctly.
    expect(capturedRaw).toContain("From: Atelier — Alex's office <alex@atelier.example>");
    expect(capturedRaw).toContain("To: Sam Rodriguez <sam@example.com>");
    expect(capturedRaw).toContain("Subject: Re: Quote for fence repair");
    expect(capturedRaw).toContain("Thanks Sam");
  });

  it("adds In-Reply-To and References headers when the input carries inReplyToMessageId", async () => {
    let capturedRaw: string | null = null;
    stubFetch((_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { raw?: string };
      capturedRaw = base64UrlDecode(body.raw!);
      return new Response(JSON.stringify({ id: "gm_msg_x", threadId: "gm_thread_x" }), {
        status: 200,
      });
    });
    await messageSendTool.invoke(
      mkCtx({
        access_token: "live-token",
        from_address: "alex@atelier.example",
      }),
      {
        inputs: { ...baseInputs, inReplyToMessageId: "sam@example.com/original-id" },
        summary: "Send reply",
      },
    );
    expect(capturedRaw).toContain("In-Reply-To: <sam@example.com/original-id>");
    expect(capturedRaw).toContain("References: <sam@example.com/original-id>");
  });

  it("refreshes an expired access token before sending", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    let n = 0;
    stubFetch((url, init) => {
      n++;
      if (n === 1) {
        expect(url).toBe("https://oauth2.googleapis.com/token");
        const body = String(init?.body ?? "");
        expect(body).toContain("refresh_token=rt-abc");
        return new Response(
          JSON.stringify({ access_token: "fresh-gmail-token", expires_in: 3600 }),
          { status: 200 },
        );
      }
      expect(url).toContain("gmail.googleapis.com");
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer fresh-gmail-token");
      return new Response(JSON.stringify({ id: "gm_msg_2", threadId: "t2" }), { status: 200 });
    });
    const res = await messageSendTool.invoke(
      mkCtx(
        {
          access_token: "old-token",
          refresh_token: "rt-abc",
          client_id: "cid",
          client_secret: "csec",
          from_address: "alex@atelier.example",
        },
        past,
      ),
      { inputs: baseInputs, summary: "Send reply" },
    );
    expect(res.outputs.provider).toBe("gmail");
    expect(res.outputs.sentMessageId).toBe("gm_msg_2");
  });

  it("falls back to mock if the Gmail API returns an error", async () => {
    stubFetch(() => new Response("nope", { status: 500 }));
    const res = await messageSendTool.invoke(
      mkCtx({
        access_token: "live-token",
        from_address: "alex@atelier.example",
      }),
      { inputs: baseInputs, summary: "Send reply" },
    );
    expect(res.outputs.provider).toBe("mock");
  });

  it("falls back to mock if the gmail credential has no from_address and none is supplied", async () => {
    let called = false;
    stubFetch(() => {
      called = true;
      return new Response("shouldn't run", { status: 200 });
    });
    const res = await messageSendTool.invoke(
      mkCtx({ access_token: "live-token" }),
      { inputs: baseInputs, summary: "Send reply" },
    );
    expect(called).toBe(false);
    expect(res.outputs.provider).toBe("mock");
  });
});
