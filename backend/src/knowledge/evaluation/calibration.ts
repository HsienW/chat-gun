import type { CaseResult } from "./runner.js";

/**
 * Evidence-threshold calibration. Only dev-split cases may be used; test cases are rejected so a
 * published test figure is never produced by a threshold that saw the test set.
 *
 * Decision rule mirrors the runtime: a case returns evidence when its top candidate score clears
 * the threshold. Answerable cases should pass; abstain cases should not.
 */
export interface CalibrationPoint {
  caseId: string;
  expectedKind: "answerable" | "abstain";
  topScore: number;
}

export interface CalibrationResult {
  threshold: number;
  balancedAccuracy: number;
  truePassRate: number;
  trueBlockRate: number;
  margin: number;
  points: number;
}

export class CalibrationInputError extends Error {
  readonly name = "CalibrationInputError";
}

export function calibrationPoints(results: readonly CaseResult[], scoreOf: "similarity" | "rerankScore"): CalibrationPoint[] {
  return results.map((result) => {
    if (result.split !== "dev") throw new CalibrationInputError(`Calibration must use the dev split only: ${result.caseId}`);
    if (result.status !== "completed") throw new CalibrationInputError(`Calibration requires completed cases: ${result.caseId}`);
    const top = result.candidateScores[0];
    const score = top === undefined ? 0 : scoreOf === "similarity" ? top.similarity : top.rerankScore;
    if (score === undefined) throw new CalibrationInputError(`Case ${result.caseId} has no ${scoreOf}`);
    return { caseId: result.caseId, expectedKind: result.expectedKind, topScore: score };
  });
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function evaluate(points: readonly CalibrationPoint[], threshold: number) {
  const answerable = points.filter((point) => point.expectedKind === "answerable");
  const abstain = points.filter((point) => point.expectedKind === "abstain");
  const truePassRate = answerable.filter((point) => point.topScore >= threshold).length / answerable.length;
  const trueBlockRate = abstain.filter((point) => point.topScore < threshold).length / abstain.length;
  const margin = Math.min(...points.map((point) => Math.abs(point.topScore - threshold)));
  return { truePassRate, trueBlockRate, balancedAccuracy: (truePassRate + trueBlockRate) / 2, margin };
}

/**
 * Chooses the threshold with the best balanced accuracy; ties go to the largest margin from any
 * observed score, so the boundary sits in the middle of the gap rather than on a data point.
 */
export function calibrateThreshold(points: readonly CalibrationPoint[]): CalibrationResult {
  if (!points.some((point) => point.expectedKind === "answerable") || !points.some((point) => point.expectedKind === "abstain")) {
    throw new CalibrationInputError("Calibration needs both answerable and abstain dev cases");
  }
  const scores = [...new Set(points.map((point) => point.topScore))].sort((left, right) => left - right);
  const candidates = [scores[0] - 0.01, ...scores.slice(1).map((score, index) => (score + scores[index]) / 2), scores[scores.length - 1] + 0.01];
  let best: CalibrationResult | undefined;
  for (const candidate of candidates) {
    const threshold = round(candidate);
    const metrics = evaluate(points, threshold);
    const better =
      best === undefined ||
      metrics.balancedAccuracy > best.balancedAccuracy ||
      (metrics.balancedAccuracy === best.balancedAccuracy && metrics.margin > best.margin);
    if (better) best = { threshold, ...metrics, points: points.length };
  }
  if (best === undefined) throw new CalibrationInputError("No calibration candidate");
  return { ...best, margin: round(best.margin) };
}

/** Scores the test split with a fixed threshold; used only to report, never to choose. */
export function scoreHeldOut(results: readonly CaseResult[], scoreOf: "similarity" | "rerankScore", threshold: number) {
  const points = results.flatMap((result) => {
    if (result.status !== "completed") return [];
    const top = result.candidateScores[0];
    const score = top === undefined ? 0 : scoreOf === "similarity" ? top.similarity : top.rerankScore ?? 0;
    return [{ caseId: result.caseId, expectedKind: result.expectedKind, topScore: score }];
  });
  return evaluate(points, threshold);
}
