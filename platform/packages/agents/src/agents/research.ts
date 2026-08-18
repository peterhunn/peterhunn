import { z } from "zod";
import type { ToolDefinition } from "@atelier/domain";
import type { Agent, AgentContext, AgentTaskOutput, Intent } from "../types.js";

// Research agent — the first agent that uses the multi-turn LLM
// tool-use loop. Two model-side tools (search_web, fetch_url) let the
// model gather information before summarizing. Both are mocked here;
// real implementations would hit a search API and a fetch service
// (or a browser-driver behind a sandbox).
//
// LLM tools are distinct from the ToolRegistry used by policy-gated
// actions. These are read-only research primitives the model may
// invoke during its own reasoning; they don't produce actions.

export const ResearchQueryAttrs = z.object({
  question: z.string().min(1),
  sources: z.array(z.string()).optional(),
  category: z.enum(["vendor", "product", "info", "other"]).optional(),
});

const NAME = "research";
const VERSION = "0.1.0";

const searchWebDef: ToolDefinition = {
  name: "search_web",
  description:
    "Search the web for a short natural-language query. Returns a small list of {title, url, snippet}.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
    },
    required: ["query"],
  },
};

const fetchUrlDef: ToolDefinition = {
  name: "fetch_url",
  description: "Fetch the readable text of a URL. Returns { url, title, text }.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string" },
    },
    required: ["url"],
  },
};

// Mock handlers — deterministic canned data so the loop runs without
// external network calls. Real implementations swap these in the
// runtime factory.
const mockSearch = (query: string): Array<{ title: string; url: string; snippet: string }> => [
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

const mockFetch = (url: string): { url: string; title: string; text: string } => ({
  url,
  title: `Fetched: ${url}`,
  text: `Mocked page content for ${url}. Real fetch would return the readable text.`,
});

export const researchAgent: Agent = {
  name: NAME,
  version: VERSION,

  handles(intent: Intent): boolean {
    return intent.kind === "research.query";
  },

  async handle(intent: Intent, ctx: AgentContext): Promise<AgentTaskOutput> {
    const parsed = ResearchQueryAttrs.safeParse(intent.attrs);
    if (!parsed.success) {
      return {
        state: "failed",
        errorMessage: `Invalid intent attrs: ${parsed.error.message}`,
      };
    }
    const attrs = parsed.data;
    const structured = attrs.sources !== undefined && attrs.sources.length > 0;
    const taskClass = structured ? "research.structured" : "research.open";

    const toolTrace: Array<{ name: string; input: unknown; summary: string }> = [];

    const result = await ctx.callModelWithTools(
      {
        taskClass,
        messages: [
          {
            role: "system",
            content:
              "You are the ATELIER Research agent. Use search_web and fetch_url to gather information, then produce a short summary (5–8 lines) with the top options and a clear recommendation. Cite the URLs you consulted at the end.",
            cache: true,
          },
          {
            role: "user",
            content: attrs.sources
              ? `Question: ${attrs.question}\n\nRestrict yourself to these sources: ${attrs.sources.join(", ")}`
              : `Question: ${attrs.question}`,
          },
        ],
        maxOutputTokens: 800,
      },
      {
        tools: [searchWebDef, fetchUrlDef],
        maxTurns: 6,
        handleToolUse: async ({ name, input }) => {
          if (name === "search_web") {
            const query = String(input["query"] ?? "");
            const results = mockSearch(query);
            toolTrace.push({
              name,
              input,
              summary: `${results.length} results for "${query}"`,
            });
            return { results };
          }
          if (name === "fetch_url") {
            const url = String(input["url"] ?? "");
            const page = mockFetch(url);
            toolTrace.push({ name, input, summary: `fetched ${url}` });
            return page;
          }
          return { error: `unknown_tool:${name}` };
        },
      },
    );

    const summary = result.finalContent.trim();
    if (!summary) {
      return {
        state: "failed",
        decisionSummary: "Model returned no summary.",
        outputs: {
          question: attrs.question,
          toolTrace,
          turns: result.turns,
        },
      };
    }

    ctx.logger.info("research completed", {
      question: attrs.question,
      turns: result.turns,
      tokenCost: result.totalCostUsdEstimated,
    });

    return {
      state: "completed",
      decisionSummary: `Researched "${attrs.question}" in ${result.turns} turn${
        result.turns === 1 ? "" : "s"
      } (${toolTrace.length} tool call${toolTrace.length === 1 ? "" : "s"}).`,
      outputs: {
        question: attrs.question,
        category: attrs.category ?? "info",
        summary,
        toolTrace,
        turns: result.turns,
        totalCostUsdEstimated: result.totalCostUsdEstimated,
      },
    };
  },
};
