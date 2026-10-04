import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";

import { configureNetwork } from "../platform/network.js";
import {
  EgressPolicyError,
  fetchWithValidatedRedirects,
} from "../runtime/tool-dispatch/egress-policy.js";
import { WEB_SEARCH_EGRESS_POLICY } from "../runtime/tool-dispatch/production-egress-policies.js";
import { readResolvedSecret } from "../runtime/tool-dispatch/secret-broker.js";

configureNetwork();

type TavilySearchDepth = "basic" | "advanced";
type TavilyTopic = "general" | "news" | "finance";
type TavilyTimeRange = "day" | "week" | "month" | "year";

type TavilySearchResult = {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
  raw_content?: string | null;
  favicon?: string;
  published_date?: string;
};

type TavilySearchResponse = {
  query?: string;
  answer?: string;
  results?: TavilySearchResult[];
  response_time?: number | string;
  auto_parameters?: {
    topic?: string;
    search_depth?: string;
  };
  usage?: {
    credits?: number;
  };
  request_id?: string;
};

type NormalizedSearchResult = {
  title: string;
  url: string;
  snippet: string;
  sourceType: TavilyTopic;
  score?: number;
  age?: string;
  favicon?: string;
  query: string;
};

function hasUsableApiKey(apiKey: string | undefined): apiKey is string {
  if (!apiKey) {
    return false;
  }

  const normalized = apiKey.trim().toLowerCase();
  return !["", "your_tavily_api_key", "your_tavily_api_key_here", "changeme"].includes(
    normalized
  );
}

function mapFreshness(freshness: "pd" | "pw" | "pm" | "py" | undefined): TavilyTimeRange | undefined {
  switch (freshness) {
    case "pd":
      return "day";
    case "pw":
      return "week";
    case "pm":
      return "month";
    case "py":
      return "year";
    default:
      return undefined;
  }
}

async function postJson<T>(url: URL, body: unknown, headers: Record<string, string>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetchWithValidatedRedirects(
      url,
      {
        method: "POST",
        signal: controller.signal,
        headers,
        body: JSON.stringify(body),
      },
      WEB_SEARCH_EGRESS_POLICY
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `${response.status} ${response.statusText}${errorText ? ` - ${errorText.slice(0, 500)}` : ""}`
      );
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeResults(
  results: TavilySearchResult[],
  query: string,
  topic: TavilyTopic
): NormalizedSearchResult[] {
  return results
    .map((result) => ({
      title: result.title ?? "Untitled",
      url: result.url ?? "",
      snippet: result.content ?? result.raw_content ?? "",
      sourceType: topic,
      score: result.score,
      age: result.published_date,
      favicon: result.favicon,
      query,
    }))
    .filter((result) => result.url.length > 0);
}

function formatResults(results: NormalizedSearchResult[]): string {
  if (results.length === 0) {
    return "No results";
  }

  return results
    .map((result, index) => {
      return [
        `${index + 1}. ${result.title}`,
        `URL: ${result.url}`,
        result.snippet ? `Snippet: ${result.snippet}` : undefined,
        result.score !== undefined ? `Score: ${result.score}` : undefined,
        result.age ? `Published/Updated: ${result.age}` : undefined,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

export const webSearchTool = tool(
  async (
    { query, count, freshness, format, searchDepth, topic },
    config?: RunnableConfig
  ) => {
    const apiKey = readResolvedSecret(config, "env:TAVILY_API_KEY");
    const requestedFormat = format ?? "text";
    const selectedTopic = topic ?? "general";

    if (!hasUsableApiKey(apiKey)) {
      const message = [
        "Error: TAVILY_API_KEY is not configured.",
        "Set TAVILY_API_KEY in backend/.env to enable real web search.",
        "This tool intentionally does not fabricate search results.",
      ].join("\n");
      return requestedFormat === "json"
        ? JSON.stringify({ error: message, results: [] }, null, 2)
        : message;
    }

    try {
      const maxResults = Math.min(Math.max(count ?? 5, 1), 20);
      const body = {
        query,
        max_results: maxResults,
        search_depth: searchDepth ?? "basic",
        topic: selectedTopic,
        time_range: mapFreshness(freshness),
        include_answer: false,
        include_raw_content: false,
        include_images: false,
      };

      const data = await postJson<TavilySearchResponse>(
        new URL("https://api.tavily.com/search"),
        body,
        {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "User-Agent": "chat-gun/0.1",
        }
      );

      const normalizedResults = normalizeResults(
        data.results ?? [],
        data.query ?? query,
        selectedTopic
      );

      if (requestedFormat === "json") {
        return JSON.stringify(
          {
            query: data.query ?? query,
            provider: "Tavily Search API",
            results: normalizedResults,
            responseTime: data.response_time,
            usage: data.usage,
            requestId: data.request_id,
          },
          null,
          2
        );
      }

      return [
        `Search query: ${data.query ?? query}`,
        "Provider: Tavily Search API",
        data.usage?.credits !== undefined ? `Credits used: ${data.usage.credits}` : undefined,
        data.request_id ? `Request ID: ${data.request_id}` : undefined,
        "",
        "Results:",
        formatResults(normalizedResults),
      ]
        .filter((part) => part !== undefined && part.length > 0)
        .join("\n");
    } catch (error) {
      if (error instanceof EgressPolicyError) throw error;
      const message = `Error: web_search failed - ${
        error instanceof Error ? error.message : String(error)
      }`;
      return requestedFormat === "json"
        ? JSON.stringify({ error: message, results: [] }, null, 2)
        : message;
    }
  },
  {
    name: "web_search",
    description:
      "Search the public web using Tavily Search API. Use this for current events, factual lookup, sources, product/news/law/regulation changes, and research tasks that need internet evidence.",
    schema: z.object({
      query: z.string().min(1).describe("Search query."),
      count: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Number of results, 1 to 20. Default is 5."),
      freshness: z
        .enum(["pd", "pw", "pm", "py"])
        .optional()
        .describe("Optional recency filter: pd day, pw week, pm month, py year."),
      searchDepth: z
        .enum(["basic", "advanced"])
        .optional()
        .describe("Tavily search depth. basic costs fewer credits; advanced does deeper retrieval."),
      topic: z
        .enum(["general", "news", "finance"])
        .optional()
        .describe("Tavily search topic. Use news for current events and finance for market/company financial topics."),
      format: z
        .enum(["text", "json"])
        .optional()
        .describe("Return format. Use json when another graph node will rank or deduplicate results."),
    }),
  }
);
