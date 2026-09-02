import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { extractDocumentFields } from "../src/tools/document-extract.js";

const ANTHROPIC = "https://api.anthropic.com/v1/messages";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

beforeEach(() => {
  vi.unstubAllEnvs();
  // Force the "no key" branch by default. Tests that want the
  // live path pass apiKey explicitly.
  vi.stubEnv("ANTHROPIC_API_KEY", "");
});
afterEach(() => {
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

  it("PDF path: pdf-parse failure lands as mock with pdf_parse reason", async () => {
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
    server.use(
      http.post(ANTHROPIC, () =>
        HttpResponse.json({
          content: [
            {
              type: "text",
              text: 'Here you go:\n```json\n{"title": "US Passport", "category": "identity", "expiresAt": "2029-05-01T00:00:00Z"}\n```',
            },
          ],
        }),
      ),
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
    server.use(
      http.post(ANTHROPIC, () => HttpResponse.text("bad", { status: 400 })),
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
