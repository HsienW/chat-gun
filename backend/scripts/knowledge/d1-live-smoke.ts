/**
 * D1 live smoke: one real mcp_agent turn that must retrieve through kb_search (X14 dispatch) and
 * answer with citations that resolve to stored chunks.
 *
 * Usage (from backend/):
 *   KNOWLEDGE_DATABASE_URL=... TOOL_AUTHORIZATION_PROFILE=development \
 *     npx tsx --env-file=.env scripts/knowledge/d1-live-smoke.ts <evidence-file>
 *
 * This is live evidence, not a deterministic test: it calls the configured chat and embedding models.
 */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";

import { mcpAgentGraph } from "../../src/agents/mcp-agent.js";
import { verifyAnswerCitations } from "../../src/knowledge/citation-verification.js";
import { getSharedKnowledgeStore } from "../../src/knowledge/connection.js";
import { kbSearchResultSchema, type KbSearchResult } from "../../src/knowledge/retrieval.js";
import type { PgKnowledgeStore } from "../../src/knowledge/store.js";

const QUESTION =
  "How many days do I have to return an item, and do Plus members get a longer return window? " +
  "Please check the store knowledge base and cite your sources.";

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : (part as { text?: string }).text ?? "")).join("");
  }
  return "";
}

async function main(): Promise<void> {
  const evidenceFile = process.argv[2];
  const threadId = `kb-d1-${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const state = (await mcpAgentGraph.invoke(
    { messages: [new HumanMessage(QUESTION)] },
    { configurable: { thread_id: threadId, requestId: threadId, runId: threadId, taskId: threadId } }
  )) as { messages: unknown[] };

  const kbCalls = state.messages.filter(
    (message): message is AIMessage => message instanceof AIMessage && (message.tool_calls ?? []).some((call) => call.name === "kb_search")
  );
  const kbResults: KbSearchResult[] = [];
  const kbRaw: unknown[] = [];
  for (const message of state.messages) {
    if (!(message instanceof ToolMessage) || message.name !== "kb_search") continue;
    const raw = text(message.content);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { unparsed: raw.slice(0, 500) };
    }
    kbRaw.push(parsed);
    const result = kbSearchResultSchema.safeParse(parsed);
    if (result.success) kbResults.push(result.data);
  }
  const finalMessage = [...state.messages].reverse().find((message) => message instanceof AIMessage && (message.tool_calls ?? []).length === 0);
  const answer = finalMessage ? text((finalMessage as AIMessage).content) : "";
  const verification = verifyAnswerCitations(answer, kbResults);

  const store = (await getSharedKnowledgeStore()) as PgKnowledgeStore;
  const storedChunkChecks = [];
  for (const result of kbResults) {
    if (result.outcome !== "evidence_found") continue;
    for (const citation of result.citations) {
      const count = await store.countChunks("public", citation.sourceId);
      storedChunkChecks.push({ citationId: citation.citationId, sourceId: citation.sourceId, chunkId: citation.chunkId, sourceChunksStored: count });
    }
  }

  const evidence = {
    kind: "x42-d1-live-smoke",
    startedAt,
    endedAt: new Date().toISOString(),
    graph: "mcp_agent",
    threadId,
    question: QUESTION,
    kbSearchToolCalls: kbCalls.flatMap((message) => (message.tool_calls ?? []).filter((call) => call.name === "kb_search").map((call) => call.args)),
    kbSearchResults: kbRaw,
    answer,
    citationVerification: verification,
    storedChunkChecks,
    gatePassed:
      kbCalls.length > 0 &&
      kbResults.some((result) => result.outcome === "evidence_found") &&
      verification.status === "verified" &&
      storedChunkChecks.every((check) => check.sourceChunksStored > 0),
  };
  if (evidenceFile) await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ gatePassed: evidence.gatePassed, kbSearchCalls: kbCalls.length, citationVerification: verification, answer })}\n`);
  process.exit(evidence.gatePassed ? 0 : 1);
}

main().catch((error: unknown) => {
  process.stderr.write(`D1 smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
