import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { messageSendTool } from "../src/tools/message.js";
import type { HouseholdId } from "@atelier/domain";
import type { StoredCredential, ToolContext } from "../src/types.js";

const GMAIL_SEND = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const OAUTH_TOKEN = "https://oauth2.googleapis.com/token";
const HH = "hh_test" as HouseholdId;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

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
  const padded =
    s.replace(/-/g, "+").replace(/_/g, "/") +
    "==".slice(0, (4 - (s.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf-8");
};

describe("message.send", () => {
  it("falls back to mock when no gmail credential is stored", async () => {
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
    server.use(
      http.post(GMAIL_SEND, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer live-token");
        const body = (await request.json()) as { raw?: string };
        expect(typeof body.raw).toBe("string");
        capturedRaw = base64UrlDecode(body.raw!);
        return HttpResponse.json({
          id: "gm_msg_123",
          threadId: "gm_thread_1",
        });
      }),
    );

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

    expect(capturedRaw).toContain("From: Atelier — Alex's office <alex@atelier.example>");
    expect(capturedRaw).toContain("To: Sam Rodriguez <sam@example.com>");
    expect(capturedRaw).toContain("Subject: Re: Quote for fence repair");
    expect(capturedRaw).toContain("Thanks Sam");
  });

  it("adds In-Reply-To and References headers when the input carries inReplyToMessageId", async () => {
    let capturedRaw: string | null = null;
    server.use(
      http.post(GMAIL_SEND, async ({ request }) => {
        const body = (await request.json()) as { raw?: string };
        capturedRaw = base64UrlDecode(body.raw!);
        return HttpResponse.json({ id: "gm_msg_x", threadId: "gm_thread_x" });
      }),
    );
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
    server.use(
      http.post(OAUTH_TOKEN, async ({ request }) => {
        const body = await request.text();
        expect(body).toContain("refresh_token=rt-abc");
        return HttpResponse.json({
          access_token: "fresh-gmail-token",
          expires_in: 3600,
          token_type: "Bearer",
        });
      }),
      http.post(GMAIL_SEND, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer fresh-gmail-token");
        return HttpResponse.json({ id: "gm_msg_2", threadId: "t2" });
      }),
    );
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
    server.use(
      http.post(GMAIL_SEND, () => HttpResponse.text("nope", { status: 500 })),
    );
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
    // No handlers registered — the tool should short-circuit
    // before making any request. onUnhandledRequest: "error"
    // guarantees a live call would fail loudly.
    const res = await messageSendTool.invoke(
      mkCtx({ access_token: "live-token" }),
      { inputs: baseInputs, summary: "Send reply" },
    );
    expect(res.outputs.provider).toBe("mock");
  });
});
