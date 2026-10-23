/**
 * Scans exported Opik traces and spans for the resolved model credential (T9 trace-exporter coverage).
 *
 * Usage (from backend/):
 *   npx tsx --env-file=.env scripts/knowledge/opik-trace-leak-scan.ts [--since 2026-10-23T00:00:00Z]
 *
 * Prints counts only: never trace content and never the credential.
 */
import { createKnowledgeSecretBroker, createSystemExecutionContext, KNOWLEDGE_MODEL_SECRET } from "../../src/knowledge/connection.js";
import { getAgentRuntimeConfig } from "../../src/platform/runtime-config.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

/** Generic key patterns, so a leak of a different credential is also caught. */
const SECRET_PATTERN = /\bsk-[A-Za-z0-9_-]{16,}|\bBearer\s+[A-Za-z0-9._~+/-]{16,}/u;

async function main(): Promise<void> {
  const runtime = getAgentRuntimeConfig();
  if (!runtime.opikEnabled || !runtime.opikApiKey) throw new Error("Opik is not configured; nothing to scan");
  const since = argument("--since") ?? `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
  const credential = (await createKnowledgeSecretBroker().resolve(KNOWLEDGE_MODEL_SECRET, createSystemExecutionContext("kb-trace-scan"))).value;

  const sdk = await import("opik");
  const client = new sdk.Opik({
    apiKey: runtime.opikApiKey,
    apiUrl: runtime.opikHost,
    projectName: runtime.opikProjectName,
    ...(runtime.opikWorkspace ? { workspaceName: runtime.opikWorkspace } : {}),
  });
  const filterString = `start_time >= "${since}"`;
  const traces = await client.searchTraces({ projectName: runtime.opikProjectName, filterString, truncate: false, maxResults: 2000 });
  const spans = await client.searchSpans({ projectName: runtime.opikProjectName, filterString, truncate: false, maxResults: 2000 });

  const scan = (items: readonly unknown[]) => {
    let credentialHits = 0;
    let patternHits = 0;
    for (const item of items) {
      const text = JSON.stringify(item);
      if (text.includes(credential)) credentialHits += 1;
      if (SECRET_PATTERN.test(text)) patternHits += 1;
    }
    return { scanned: items.length, credentialHits, patternHits };
  };
  const result = {
    project: runtime.opikProjectName,
    since,
    redactionEnabled: runtime.opikRedactEnabled,
    traces: scan(traces),
    spans: scan(spans),
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.traces.credentialHits + result.spans.credentialHits > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`Trace scan failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
