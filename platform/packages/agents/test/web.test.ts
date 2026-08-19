import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { searchWeb, fetchUrl } from "../src/tools/web.js";

const stubFetch = (impl: (url: string, init?: RequestInit) => Response) => {
  vi.stubGlobal("fetch", vi.fn(async (u: string, i?: RequestInit) => impl(u, i)));
};

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.stubEnv("TAVILY_API_KEY", "");
  vi.stubEnv("SERPER_API_KEY", "");
  vi.stubEnv("BRAVE_SEARCH_API_KEY", "");
  vi.stubEnv("JINA_API_KEY", "");
  vi.stubEnv("ATELIER_DISABLE_JINA", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("searchWeb", () => {
  it("falls back to mock results when no provider key is set", async () => {
    const res = await searchWeb("ergonomic chair");
    expect(res.provider).toBe("mock");
    expect(res.results).toHaveLength(3);
    expect(res.results[0]!.title).toContain("ergonomic chair");
  });

  it("calls Tavily when TAVILY_API_KEY is set and parses its results", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tv-key");
    stubFetch((url, init) => {
      expect(url).toContain("api.tavily.com/search");
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        api_key?: string;
        query?: string;
      };
      expect(body.api_key).toBe("tv-key");
      expect(body.query).toBe("fence contractor");
      return new Response(
        JSON.stringify({
          results: [
            {
              title: "Best fence contractors",
              url: "https://example.com/a",
              content: "Top-rated contractors in the area.",
            },
          ],
        }),
        { status: 200 },
      );
    });
    const res = await searchWeb("fence contractor");
    expect(res.provider).toBe("tavily");
    expect(res.results).toHaveLength(1);
    expect(res.results[0]!.url).toBe("https://example.com/a");
  });

  it("calls Serper when only SERPER_API_KEY is set and parses organic[]", async () => {
    vi.stubEnv("SERPER_API_KEY", "sr-key");
    stubFetch((url, init) => {
      expect(url).toContain("google.serper.dev/search");
      const headers = init?.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("sr-key");
      return new Response(
        JSON.stringify({
          organic: [
            { title: "R1", link: "https://example.com/r1", snippet: "s1" },
            { title: "R2", link: "https://example.com/r2", snippet: "s2" },
          ],
        }),
        { status: 200 },
      );
    });
    const res = await searchWeb("hvac dallas");
    expect(res.provider).toBe("serper");
    expect(res.results.map((r) => r.url)).toEqual([
      "https://example.com/r1",
      "https://example.com/r2",
    ]);
  });

  it("calls Brave when only BRAVE_SEARCH_API_KEY is set and uses the x-subscription-token header", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "br-key");
    stubFetch((url, init) => {
      expect(url).toContain("api.search.brave.com");
      const headers = init?.headers as Record<string, string>;
      expect(headers["x-subscription-token"]).toBe("br-key");
      return new Response(
        JSON.stringify({
          web: {
            results: [{ title: "B1", url: "https://example.com/b1", description: "d1" }],
          },
        }),
        { status: 200 },
      );
    });
    const res = await searchWeb("stroller comparison");
    expect(res.provider).toBe("brave");
    expect(res.results[0]!.title).toBe("B1");
  });

  it("falls back to mock if the configured provider throws", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tv-key");
    stubFetch(() => new Response("boom", { status: 500 }));
    const res = await searchWeb("thing");
    expect(res.provider).toBe("mock");
  });
});

describe("fetchUrl", () => {
  it("uses Jina Reader by default and extracts the Title line", async () => {
    stubFetch((url) => {
      expect(url).toBe("https://r.jina.ai/https://example.com/page");
      return new Response(
        "Title: The Example Page\nURL Source: https://example.com/page\n\nBody text here.",
        { status: 200 },
      );
    });
    const res = await fetchUrl("https://example.com/page");
    expect(res.provider).toBe("jina");
    expect(res.title).toBe("The Example Page");
    expect(res.text).toContain("Body text here");
  });

  it("passes Authorization when JINA_API_KEY is set", async () => {
    vi.stubEnv("JINA_API_KEY", "jn-key");
    stubFetch((_url, init) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer jn-key");
      return new Response("Title: T\n\nX", { status: 200 });
    });
    const res = await fetchUrl("https://example.com/x");
    expect(res.provider).toBe("jina_authed");
  });

  it("falls back to raw fetch when Jina is disabled, extracting <title>", async () => {
    vi.stubEnv("ATELIER_DISABLE_JINA", "1");
    stubFetch(() =>
      new Response(
        "<html><head><title>Raw Page</title></head><body><p>Hello world.</p></body></html>",
        { status: 200 },
      ),
    );
    const res = await fetchUrl("https://example.com/raw");
    expect(res.provider).toBe("raw_fetch");
    expect(res.title).toBe("Raw Page");
    expect(res.text).toContain("Hello world");
  });

  it("returns a mock when both Jina and raw fetch fail", async () => {
    stubFetch(() => new Response("nope", { status: 500 }));
    const res = await fetchUrl("https://example.com/y");
    expect(res.provider).toBe("mock");
    expect(res.text).toContain("Mocked page content");
  });
});
