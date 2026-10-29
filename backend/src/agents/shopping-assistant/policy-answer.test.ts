import { readFileSync } from "node:fs";

import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { LlmPolicyAnswerSynthesizer, parsePolicyAnswer, PolicyAnswerOutputError } from "./policy-answer.js";

const evidence = {
  schemaVersion: "kb_search_result@1" as const,
  outcome: "evidence_found" as const,
  citations: [
    {
      citationId: "c1",
      chunkId: "policy-return-window#0",
      sourceId: "policy-return-window",
      sourceVersion: 1,
      sourceType: "policy" as const,
      title: "Return Window",
      offsetStart: 0,
      offsetEnd: 40,
    },
  ],
  chunks: [{ citationId: "c1", chunkId: "policy-return-window#0", content: "Most items can be returned within 30 days.", score: 0.9 }],
  retrieval: {
    mode: "vector_rerank" as const,
    embeddingSpaceId: "space-1",
    thresholdVersion: "t-1",
    configVersion: "c-1",
    candidateCount: 1,
    passedCount: 1,
  },
};

describe("policy answer parsing", () => {
  it("accepts the strict answer object", () => {
    expect(parsePolicyAnswer('{"abstained":false,"answer":"30 days [c1]."}')).toEqual({ abstained: false, answer: "30 days [c1]." });
  });

  it.each([
    ["an extra citations field", '{"abstained":false,"answer":"x","citations":["c1"]}'],
    ["a missing abstained flag", '{"answer":"x"}'],
    ["plain text", "30 days [c1]."],
  ])("rejects %s", (_case, output) => {
    expect(parsePolicyAnswer(output)).toBeUndefined();
  });
});

describe("LlmPolicyAnswerSynthesizer", () => {
  it("sends the question and numbered evidence as data and returns the parsed answer", async () => {
    const invoke = vi.fn(async (_input: unknown) => new AIMessage({ content: '{"abstained":false,"answer":"30 天 [c1]。"}' }));
    const synthesizer = new LlmPolicyAnswerSynthesizer(() => ({ invoke }));

    await expect(synthesizer.synthesize("退貨期限？", evidence)).resolves.toEqual({ abstained: false, answer: "30 天 [c1]。" });
    const [system, human] = invoke.mock.calls[0]?.[0] as unknown as { content: string }[];
    expect(system?.content).not.toContain("退貨期限？");
    expect(human?.content).toContain("[c1] Return Window\nMost items can be returned within 30 days.");
  });

  it("fails with a typed error instead of regenerating an invalid answer", async () => {
    const invoke = vi.fn(async () => new AIMessage({ content: "Returns are free." }));

    await expect(new LlmPolicyAnswerSynthesizer(() => ({ invoke })).synthesize("x", evidence)).rejects.toBeInstanceOf(
      PolicyAnswerOutputError
    );
    expect(invoke).toHaveBeenCalledOnce();
  });
});

describe("shopping policy golden cases", () => {
  const golden = z
    .object({
      provenance: z.object({ synthetic: z.literal(true) }).passthrough(),
      cases: z.array(
        z
          .object({
            caseId: z.string(),
            language: z.string(),
            question: z.string().min(1),
            expectedBehavior: z.enum(["answer_with_citations", "abstain"]),
            expectedSourceIds: z.array(z.string()),
            reference: z.object({ caseId: z.string(), inspection: z.string() }).strict().nullable(),
          })
          .strict()
      ),
    })
    .parse(JSON.parse(readFileSync(new URL("../../../data/commerce/shopping-policy-golden-v1.json", import.meta.url), "utf8")));

  it("includes the four X42 judge-disagreement cases and both behaviours", () => {
    expect(golden.cases.flatMap((entry) => (entry.reference ? [entry.reference.caseId] : [])).sort()).toEqual([
      "kb-eval-v1-pol-05",
      "kb-eval-v1-pol-14",
      "kb-eval-v1-pol-15",
      "kb-eval-v1-prd-09",
    ]);
    expect(new Set(golden.cases.map((entry) => entry.expectedBehavior))).toEqual(new Set(["answer_with_citations", "abstain"]));
    for (const entry of golden.cases) {
      expect(entry.expectedSourceIds.length > 0).toBe(entry.expectedBehavior === "answer_with_citations");
    }
  });
});
