import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { extractDocumentFields } from "../src/tools/document-extract.js";

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.stubEnv("ANTHROPIC_API_KEY", "");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("document extractor", () => {
  it("falls back to mock when no ANTHROPIC_API_KEY is set", async () => {
    const res = await extractDocumentFields({
      bytes: Buffer.from([0xff, 0xd8, 0xff]),
      mime: "image/jpeg",
      filename: "us-passport-alex.jpg",
    });
    expect(res.provider).toBe("mock");
    expect(res.reason).toBe("no_anthropic_api_key");
    // Filename hint turns into a title guess.
    expect(res.proposed.title?.toLowerCase()).toContain("us passport alex");
  });

  it("falls back to mock when the MIME isn't supported (text/plain)", async () => {
    const res = await extractDocumentFields({
      bytes: Buffer.from("dummy"),
      mime: "text/plain",
      filename: "notes.txt",
      apiKey: "test-key",
    });
    expect(res.provider).toBe("mock");
    expect(res.reason).toMatch(/unsupported_mime/);
  });

  it("PDF path: pdf-parse text goes to a text-only Anthropic call", async () => {
    // Non-PDF bytes will trip pdf-parse; we test the failure branch
    // which stamps a pdf_parse reason. Full happy-path requires a
    // real PDF payload — the extractor is exercised end-to-end in
    // the API integration test via a shipped fixture there.
    const res = await extractDocumentFields({
      bytes: Buffer.from("not a real pdf"),
      mime: "application/pdf",
      filename: "policy.pdf",
      apiKey: "test-key",
    });
    expect(res.provider).toBe("mock");
    expect(res.reason).toMatch(/^pdf_parse:/);
  });

  it("calls Anthropic and parses a fenced JSON block", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toContain("/v1/messages");
        return new Response(
          JSON.stringify({
            content: [
              {
                type: "text",
                text: 'Here you go:\n```json\n{"title": "US Passport", "category": "identity", "expiresAt": "2029-05-01T00:00:00Z"}\n```',
              },
            ],
          }),
          { status: 200 },
        );
      }),
    );

    const res = await extractDocumentFields({
      bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      mime: "image/jpeg",
      filename: "passport.jpg",
      apiKey: "test-key",
    });
    expect(res.provider).toBe("anthropic");
    expect(res.proposed.title).toBe("US Passport");
    expect(res.proposed.category).toBe("identity");
    expect(res.proposed.expiresAt).toBe("2029-05-01T00:00:00Z");
  });

  it("Anthropic 4xx falls back to mock with the status in reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad", { status: 400 })),
    );
    const res = await extractDocumentFields({
      bytes: Buffer.from([0xff, 0xd8, 0xff]),
      mime: "image/jpeg",
      filename: "x.jpg",
      apiKey: "test-key",
    });
    expect(res.provider).toBe("mock");
    expect(res.reason).toBe("anthropic_400");
  });
});
