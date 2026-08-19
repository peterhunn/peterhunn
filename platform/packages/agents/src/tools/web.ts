// Real web tools used by the Research agent. Both fall back to
// deterministic mocks when the corresponding API key / URL isn't
// configured, so a fresh clone still runs; each response stamps a
// `provider` field the caller can log for provenance.

export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface WebSearchResponse {
  readonly provider: string;
  readonly results: readonly WebSearchResult[];
}

export interface WebFetchResponse {
  readonly provider: string;
  readonly url: string;
  readonly title: string;
  readonly text: string;
}

const cleanText = (s: string, cap: number): string => {
  const trimmed = s.replace(/\s+/g, " ").trim();
  return trimmed.length > cap ? `${trimmed.slice(0, cap)}…` : trimmed;
};

// Deterministic fallback data so the demo tells a plausible story even
// without any keys configured. Real adapters replace these calls.
const mockResults = (query: string): WebSearchResult[] => [
  {
    title: `Overview of ${query}`,
    url: `https://example.com/${encodeURIComponent(query)}/overview`,
    snippet: `Overview and background on ${query}.`,
  },
  {
    title: `Best options for ${query}`,
    url: `https://example.com/${encodeURIComponent(query)}/best`,
    snippet: `Comparison of leading choices for ${query}.`,
  },
  {
    title: `Local providers for ${query}`,
    url: `https://example.com/${encodeURIComponent(query)}/local`,
    snippet: `Directory of local providers offering ${query}.`,
  },
];

// Tavily — https://tavily.com/. POST with JSON body carrying the api
// key. Returns `results: [{ title, url, content }]`.
const searchTavily = async (query: string, apiKey: string): Promise<WebSearchResponse> => {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: 5,
      search_depth: "basic",
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`tavily ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  return {
    provider: "tavily",
    results: (json.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: cleanText(r.content ?? "", 300),
    })),
  };
};

// Serper — https://serper.dev. POST with an X-API-KEY header. Returns
// `organic: [{ title, link, snippet }]`.
const searchSerper = async (query: string, apiKey: string): Promise<WebSearchResponse> => {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ q: query, num: 5 }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`serper ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    organic?: Array<{ title?: string; link?: string; snippet?: string }>;
  };
  return {
    provider: "serper",
    results: (json.organic ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.link ?? "",
      snippet: cleanText(r.snippet ?? "", 300),
    })),
  };
};

// Brave Search — https://api.search.brave.com/. GET with X-Subscription-Token.
const searchBrave = async (query: string, apiKey: string): Promise<WebSearchResponse> => {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
  const res = await fetch(url, {
    headers: { accept: "application/json", "x-subscription-token": apiKey },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`brave ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  return {
    provider: "brave",
    results: (json.web?.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: cleanText(r.description ?? "", 300),
    })),
  };
};

export const searchWeb = async (query: string): Promise<WebSearchResponse> => {
  const tavily = process.env["TAVILY_API_KEY"];
  const serper = process.env["SERPER_API_KEY"];
  const brave = process.env["BRAVE_SEARCH_API_KEY"];
  try {
    if (tavily) return await searchTavily(query, tavily);
    if (serper) return await searchSerper(query, serper);
    if (brave) return await searchBrave(query, brave);
  } catch {
    // fall through to mock so the loop still returns something usable
  }
  return { provider: "mock", results: mockResults(query) };
};

// Jina Reader — https://r.jina.ai/<url> returns clean readable text.
// No key required for the basic tier; a JINA_API_KEY unlocks higher
// rate limits.
const fetchViaJina = async (url: string): Promise<WebFetchResponse> => {
  const key = process.env["JINA_API_KEY"];
  const target = `https://r.jina.ai/${url}`;
  const res = await fetch(target, {
    headers: {
      accept: "text/plain",
      ...(key && { authorization: `Bearer ${key}` }),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`jina ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = await res.text();
  // Jina returns text starting with "Title: ..." and "URL Source: ...".
  const titleMatch = /^Title:\s*(.+)$/m.exec(body);
  return {
    provider: key ? "jina_authed" : "jina",
    url,
    title: titleMatch ? titleMatch[1]!.trim() : url,
    text: cleanText(body, 6000),
  };
};

const fetchRaw = async (url: string): Promise<WebFetchResponse> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const body = await res.text();
  const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(body);
  const withoutScript = body.replace(/<script[\s\S]*?<\/script>/gi, "");
  const withoutStyle = withoutScript.replace(/<style[\s\S]*?<\/style>/gi, "");
  const text = withoutStyle.replace(/<[^>]+>/g, " ");
  return {
    provider: "raw_fetch",
    url,
    title: titleMatch ? titleMatch[1]!.trim() : url,
    text: cleanText(text, 6000),
  };
};

export const fetchUrl = async (url: string): Promise<WebFetchResponse> => {
  const disableJina = process.env["ATELIER_DISABLE_JINA"] === "1";
  if (!disableJina) {
    try {
      return await fetchViaJina(url);
    } catch {
      // fall through to raw fetch
    }
  }
  try {
    return await fetchRaw(url);
  } catch {
    return {
      provider: "mock",
      url,
      title: `Fetched: ${url}`,
      text: `Mocked page content for ${url}. (Real fetch and Jina Reader both unavailable.)`,
    };
  }
};
