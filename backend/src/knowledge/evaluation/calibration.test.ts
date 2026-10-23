import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readKnowledgeConfig } from "../config.js";
import { calibrateThreshold, calibrationPoints, CalibrationInputError, type CalibrationPoint } from "./calibration.js";
import type { CaseResult } from "./runner.js";

function point(caseId: string, expectedKind: "answerable" | "abstain", topScore: number): CalibrationPoint {
  return { caseId, expectedKind, topScore };
}

function result(caseId: string, split: "dev" | "test", similarity: number): CaseResult {
  return {
    caseId, split, expectedKind: "answerable", status: "completed", retrievalMode: "vector_only_configured",
    kbOutcome: "evidence_found", rankedSourceIds: ["a"], candidateScores: [{ sourceId: "a", similarity }],
    abstained: false, latencyMs: 1,
  };
}

describe("threshold calibration", () => {
  it("places the threshold in the middle of the gap between abstain and answerable scores", () => {
    const calibrated = calibrateThreshold([point("a1", "answerable", 0.8), point("a2", "answerable", 0.7), point("b1", "abstain", 0.4), point("b2", "abstain", 0.5)]);
    expect(calibrated).toMatchObject({ threshold: 0.6, balancedAccuracy: 1, truePassRate: 1, trueBlockRate: 1, margin: 0.1 });
  });

  it("maximizes balanced accuracy when the classes overlap", () => {
    const calibrated = calibrateThreshold([point("a1", "answerable", 0.9), point("a2", "answerable", 0.45), point("b1", "abstain", 0.5)]);
    expect(calibrated.balancedAccuracy).toBe(0.75);
  });

  it("refuses test-split cases so a published test figure never tuned its own threshold", () => {
    expect(() => calibrationPoints([result("dev-1", "dev", 0.7), result("test-1", "test", 0.7)], "similarity")).toThrow(CalibrationInputError);
  });

  it("requires both answerable and abstain cases", () => {
    expect(() => calibrateThreshold([point("a1", "answerable", 0.9)])).toThrow(CalibrationInputError);
  });

  it("keeps the runtime defaults equal to the committed calibration file", async () => {
    const file = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data", "knowledge-eval", "thresholds", "kb-threshold-v1.json");
    const calibration = JSON.parse(await readFile(file, "utf8")) as {
      thresholdVersion: string;
      source: { split: string };
      vectorOnly: { threshold: number };
      vectorRerank: { threshold: number };
    };
    const defaults = readKnowledgeConfig(() => undefined);
    expect(calibration.source.split).toBe("dev");
    expect(defaults.thresholdVersion).toBe(calibration.thresholdVersion);
    expect(defaults.vectorThreshold).toBe(calibration.vectorOnly.threshold);
    expect(defaults.rerankThreshold).toBe(calibration.vectorRerank.threshold);
  });
});
