import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadRawCorpus, prepareCorpus } from "../../knowledge/corpus.js";
import { isChainCase, parseVersionedEvalDataset, type ChainEvalCase } from "./chain-case.js";

const DATA_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data");

/** Case types `retrieval-evaluation` requires at least once (design §20.4); each must appear in the test split. */
const REQUIRED_TAGS = [
  "product_lookup",
  "policy_answer",
  "policy_abstain",
  "refund",
  "cancel",
  "multi_turn",
  "approval_denied",
  "approval_expired",
  "cancel_before_effect",
  "concurrent_duplicate",
  "response_lost",
  "injected_preapproval",
] as const;

const REQUIRED_IN_TEST = [
  "multi_turn",
  "approval_denied",
  "approval_expired",
  "cancel_before_effect",
  "concurrent_duplicate",
  "response_lost",
  "injected_preapproval",
] as const;

async function loadChainDataset() {
  const raw = JSON.parse(await readFile(join(DATA_ROOT, "commerce-eval", "chain-eval-v1.json"), "utf8")) as Record<string, unknown>;
  return { raw, parsed: parseVersionedEvalDataset(raw) };
}

describe("dataset chain-eval-v1", () => {
  it("parses every case as an eval_case@1.1 chain case with fixed, versioned splits", async () => {
    const { raw, parsed } = await loadChainDataset();

    expect(parsed.rejected).toEqual([]);
    expect(raw.orderFixtureVersion).toBe("synthetic-orders-v1");
    expect(parsed.corpusVersion).toBe("kb-v1");
    expect(parsed.cases.every(isChainCase)).toBe(true);
    expect(parsed.cases.filter((item) => item.split === "dev")).toHaveLength(5);
    expect(parsed.cases.filter((item) => item.split === "test")).toHaveLength(10);
    for (const item of parsed.cases) {
      expect(item.provenance.synthetic).toBe(true);
      expect(item.sensitivityClass).toBe("internal-synthetic");
    }
  });

  it("covers every required case type, and the required chain cases in the test split", async () => {
    const { parsed } = await loadChainDataset();
    const tagged = (tag: string, split?: "dev" | "test") =>
      parsed.cases.some((item) => item.tags.includes(tag) && (split === undefined || item.split === split));

    expect(REQUIRED_TAGS.filter((tag) => !tagged(tag))).toEqual([]);
    expect(REQUIRED_IN_TEST.filter((tag) => !tagged(tag, "test"))).toEqual([]);
  });

  it("only expects a dispatched effect after a human decision", async () => {
    const { parsed } = await loadChainDataset();
    const problems: string[] = [];
    for (const item of parsed.cases as ChainEvalCase[]) {
      for (const turn of item.expected.turns) {
        const operation = turn.operation;
        if (!operation) continue;
        if (operation.expectedTerminalState === "confirmed" && operation.humanDecision !== "approve") {
          problems.push(`${item.caseId}: confirmed without approval`);
        }
        if (operation.expectedTerminalState === "deduplicated" && operation.expectedDedupReason === undefined) {
          problems.push(`${item.caseId}: deduplicated without a reason`);
        }
      }
      if (item.tags.includes("injected_preapproval") && !item.prohibitedOutcomes.includes("follows_injected_preapproval")) {
        problems.push(`${item.caseId}: injection case without its prohibited outcome`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("grounds answers in corpus kb-v1 and operations in synthetic-orders-v1", async () => {
    const { parsed } = await loadChainDataset();
    const corpus = prepareCorpus(await loadRawCorpus(join(DATA_ROOT, "knowledge-corpus", "kb-v1", "raw")));
    const bodies = new Map(corpus.documents.map((document) => [document.sourceId, `${document.title}\n${document.body}`.toLowerCase()]));
    const orders = JSON.parse(await readFile(join(DATA_ROOT, "commerce", "synthetic-orders-v1.json"), "utf8")) as {
      orders: { orderId: string }[];
    };
    const orderIds = new Set(orders.orders.map((order) => order.orderId));
    const problems: string[] = [];
    for (const item of parsed.cases as ChainEvalCase[]) {
      for (const turn of item.expected.turns) {
        if (turn.answer?.kind === "answerable") {
          const sources = turn.answer.relevantSourceIds;
          for (const sourceId of sources) if (!bodies.has(sourceId)) problems.push(`${item.caseId}: unknown source ${sourceId}`);
          for (const fact of turn.answer.keyFacts) {
            if (!sources.some((sourceId) => bodies.get(sourceId)?.includes(fact.toLowerCase()))) {
              problems.push(`${item.caseId}: fact "${fact}" not found in its sources`);
            }
          }
        }
        if (turn.operation && !orderIds.has(turn.operation.orderFixtureId)) {
          problems.push(`${item.caseId}: unknown order ${turn.operation.orderFixtureId}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
