import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { configureNetwork } from "../platform/network.js";
import {
  EgressPolicyError,
  fetchWithValidatedRedirects,
} from "../runtime/tool-dispatch/egress-policy.js";
import { WEB_FETCH_EGRESS_POLICY } from "../runtime/tool-dispatch/production-egress-policies.js";

configureNetwork();

const DEFAULT_MAX_CONTENT_CHARS = 12_000;
const ABSOLUTE_MAX_CONTENT_CHARS = 30_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const DEFAULT_ALLOWED_PORTS = new Set(["80", "443"]);

function getAllowedPorts(): Set<string> {
  const configuredPorts = (process.env.WEB_FETCH_ALLOWED_PORTS ?? "")
    .split(",")
    .map((port) => port.trim())
    .filter(Boolean);

  return configuredPorts.length > 0 ? new Set(configuredPorts) : DEFAULT_ALLOWED_PORTS;
}

async function readLimitedText(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
    throw new Error(`Response is too large; maximum is ${MAX_RESPONSE_BYTES} bytes`);
  }

  const rawContent = await response.text();
  if (Buffer.byteLength(rawContent, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error(`Response is too large; maximum is ${MAX_RESPONSE_BYTES} bytes`);
  }

  return rawContent;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_match, codePoint: string) =>
      String.fromCodePoint(Number(codePoint))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_match, codePoint: string) =>
      String.fromCodePoint(Number.parseInt(codePoint, 16))
    );
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function htmlToReadableText(html: string): string {
  const articleLike =
    html.match(/<article[\s\S]*?<\/article>/i)?.[0] ??
    html.match(/<main[\s\S]*?<\/main>/i)?.[0] ??
    html.match(/<body[\s\S]*?<\/body>/i)?.[0] ??
    html;

  return decodeHtmlEntities(stripHtml(articleLike));
}

function extractTagContent(html: string, pattern: RegExp): string | undefined {
  const value = html.match(pattern)?.[1]?.trim();
  return value ? decodeHtmlEntities(stripHtml(value)) : undefined;
}

function extractHtmlMetadata(html: string): { title?: string; description?: string } {
  return {
    title: extractTagContent(html, /<title[^>]*>([\s\S]*?)<\/title>/i),
    description:
      extractTagContent(
        html,
        /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i
      ) ??
      extractTagContent(
        html,
        /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["'][^>]*>/i
      ),
  };
}

function clampMaxCharacters(maxCharacters: number | undefined): number {
  if (typeof maxCharacters !== "number" || !Number.isFinite(maxCharacters)) {
    return DEFAULT_MAX_CONTENT_CHARS;
  }
  return Math.max(1_000, Math.min(Math.trunc(maxCharacters), ABSOLUTE_MAX_CONTENT_CHARS));
}

function limitContent(content: string, maxCharacters: number): string {
  if (content.length <= maxCharacters) {
    return content;
  }

  return `${content.slice(0, maxCharacters)}\n\n[Truncated to ${maxCharacters} characters]`;
}

export const webFetchTool = tool(
  async ({ url, maxCharacters }) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12_000);

      try {
        const response = await fetchWithValidatedRedirects(
          url,
          {
            signal: controller.signal,
            headers: {
              Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.8",
              "User-Agent": "chat-gun/0.1",
            },
          },
          WEB_FETCH_EGRESS_POLICY,
          { allowedPorts: getAllowedPorts() }
        );

        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }

        const contentType = response.headers.get("content-type") ?? "";
        const rawContent = await readLimitedText(response);
        const metadata = contentType.includes("text/html")
          ? extractHtmlMetadata(rawContent)
          : {};
        const readableContent = contentType.includes("text/html")
          ? htmlToReadableText(rawContent)
          : decodeHtmlEntities(rawContent.trim());
        const contentLimit = clampMaxCharacters(maxCharacters);

        return [
          `Fetched URL: ${url}`,
          `Content-Type: ${contentType || "unknown"}`,
          metadata.title ? `Title: ${metadata.title}` : undefined,
          metadata.description ? `Description: ${metadata.description}` : undefined,
          "",
          limitContent(readableContent, contentLimit),
        ]
          .filter((part) => part !== undefined)
          .join("\n");
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      if (error instanceof EgressPolicyError) throw error;
      return `Error: web_fetch failed - ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  },
  {
    name: "web_fetch",
    description:
      "Fetch and extract readable text from a public HTTP/HTTPS URL. Use this after web_search to inspect source pages before answering.",
    schema: z.object({
      url: z.string().url().describe("The public HTTP or HTTPS URL to fetch."),
      maxCharacters: z
        .number()
        .int()
        .min(1_000)
        .max(30_000)
        .optional()
        .describe("Maximum readable characters to return. Default is 12000."),
    }),
  }
);
