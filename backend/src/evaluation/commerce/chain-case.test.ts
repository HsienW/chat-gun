import { describe, expect, it } from "vitest";

import { parseVersionedEvalDataset } from "./chain-case.js";

function v1Case(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "eval_case@1",
    caseId: "kb-case-1",
    datasetVersion: "chain-eval-test",
    split: "dev",
    input: { question: "How long is the return window?", language: "en" },
    expected: { kind: "answerable", relevantSourceIds: ["policy-return-window"], keyFacts: ["30 days"] },
    prohibitedOutcomes: ["unresolvable_citation"],
    scoring: { scorers: ["recall_at_5"] },
    provenance: { synthetic: true, createdAt: "2026-10-27", method: "test" },
    sensitivityClass: "internal-synthetic",
    tags: ["policy"],
    ...overrides,
  };
}

function chainCase(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "eval_case@1.1",
    caseId: "chain-case-1",
    datasetVersion: "chain-eval-test",
    split: "test",
    input: {
      question: "Do you have wireless earbuds?",
      language: "en",
      turns: [{ message: "Do you have wireless earbuds?" }, { message: "Please refund order ORD-1001." }],
    },
    expected: {
      kind: "chain",
      turns: [
        { expectedIntent: "product_lookup", answer: { kind: "answerable", relevantSourceIds: ["product-earbuds"], keyFacts: ["earbuds"] } },
        {
          expectedIntent: "order_operation",
          operation: { orderFixtureId: "ORD-1001", humanDecision: "deny", expectedTerminalState: "approval_denied" },
        },
      ],
    },
    prohibitedOutcomes: ["side_effect_without_human_decision"],
    scoring: { scorers: ["routing_accuracy", "operation_terminal_state"] },
    provenance: { synthetic: true, createdAt: "2026-10-27", method: "test" },
    sensitivityClass: "internal-synthetic",
    tags: ["chain", "approval_denied"],
    ...overrides,
  };
}

function datasetOf(cases: unknown[]) {
  return { datasetVersion: "chain-eval-test", corpusVersion: "kb-v1", synthetic: true, createdAt: "2026-10-27", cases };
}

function withTurn(index: number, patch: Record<string, unknown>) {
  const base = chainCase();
  const turns = base.expected.turns.map((turn, at) => (at === index ? { ...turn, ...patch } : turn));
  return chainCase({ expected: { kind: "chain", turns } });
}

describe("eval_case@1.1 reader", () => {
  it("reads eval_case@1 and eval_case@1.1 cases from the same dataset", () => {
    const parsed = parseVersionedEvalDataset(datasetOf([v1Case(), chainCase()]));

    expect(parsed.rejected).toEqual([]);
    expect(parsed.cases.map((item) => [item.schemaVersion, item.expected.kind])).toEqual([
      ["eval_case@1", "answerable"],
      ["eval_case@1.1", "chain"],
    ]);
  });

  it("keeps eval_case@1 semantics: a chain kind under @1 is still an unknown expected kind", () => {
    const parsed = parseVersionedEvalDataset(datasetOf([v1Case({ caseId: "kb-case-x", expected: chainCase().expected })]));

    expect(parsed.rejected).toEqual([{ index: 0, caseId: "kb-case-x", code: "EVAL_CASE_UNKNOWN_EXPECTED_KIND" }]);
  });

  it.each(["eval_case@2", "eval_case@1.2", "eval_case", 7])(
    "rejects the unsupported schema version %s with its own typed failure",
    (schemaVersion) => {
      const parsed = parseVersionedEvalDataset(datasetOf([chainCase({ schemaVersion })]));

      expect(parsed.rejected).toEqual([{ index: 0, caseId: "chain-case-1", code: "EVAL_CASE_UNSUPPORTED_SCHEMA_VERSION" }]);
    }
  );

  it.each([
    ["fewer expectations than turns", chainCase({ expected: { kind: "chain", turns: [chainCase().expected.turns[0]] } })],
    ["a question that is not the first turn", chainCase({ input: { ...chainCase().input, question: "Something else" } })],
  ])("rejects %s as a turn mismatch", (_case, raw) => {
    expect(parseVersionedEvalDataset(datasetOf([raw])).rejected[0]?.code).toBe("EVAL_CASE_CHAIN_TURN_MISMATCH");
  });

  it.each([
    ["an intent outside shopping_intent@1", withTurn(0, { expectedIntent: "weather" })],
    ["a non-terminal expected state", withTurn(1, { operation: { orderFixtureId: "ORD-1001", humanDecision: "approve", expectedTerminalState: "outcome_unknown" } })],
    ["an unknown human decision", withTurn(1, { operation: { orderFixtureId: "ORD-1001", humanDecision: "maybe", expectedTerminalState: "confirmed" } })],
    ["an unknown fault", withTurn(1, { operation: { orderFixtureId: "ORD-1001", humanDecision: "approve", fault: "disk_full", expectedTerminalState: "confirmed" } })],
    ["a new prohibited outcome on an @1 case", v1Case({ prohibitedOutcomes: ["follows_injected_preapproval"] })],
  ])("rejects %s as invalid", (_case, raw) => {
    expect(parseVersionedEvalDataset(datasetOf([raw])).rejected[0]?.code).toBe("EVAL_CASE_INVALID");
  });

  it("preserves unknown fields on chain cases and their turns", () => {
    const raw = withTurn(0, { futureHint: "keep" });
    const parsed = parseVersionedEvalDataset(datasetOf([{ ...raw, futureField: 1 }]));

    expect(parsed.rejected).toEqual([]);
    const [item] = parsed.cases as Record<string, unknown>[];
    expect(item?.futureField).toBe(1);
    expect((item?.expected as { turns: Record<string, unknown>[] }).turns[0]?.futureHint).toBe("keep");
  });

  it("reports duplicate ids and foreign dataset versions across both versions", () => {
    const parsed = parseVersionedEvalDataset(datasetOf([
      chainCase(),
      chainCase(),
      v1Case({ datasetVersion: "kb-eval-v1" }),
    ]));

    expect(parsed.rejected.map((item) => item.code)).toEqual(["EVAL_CASE_DUPLICATE_ID", "EVAL_CASE_DATASET_MISMATCH"]);
  });
});
