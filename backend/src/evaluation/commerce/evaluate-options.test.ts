import { describe, expect, it } from "vitest";

import { ChainEvaluationOptionError, resolveChainEvaluationPlan } from "./evaluate-options.js";

const databaseUrl = "postgres://user:secret@localhost:5432/db";

function failureOf(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

describe("commerce:evaluate options", () => {
  it("plans a deterministic run against the integration database", () => {
    const plan = resolveChainEvaluationPlan(["--mode", "deterministic", "--date", "2026-10-27"], {
      SIDE_EFFECT_INTEGRATION_DATABASE_URL: databaseUrl,
    });

    expect(plan).toEqual({ mode: "deterministic", databaseUrl, date: "2026-10-27" });
  });

  it("requires an explicit known mode", () => {
    for (const argv of [[], ["--mode"], ["--mode", "replay"]]) {
      const error = failureOf(() => resolveChainEvaluationPlan(argv, { SIDE_EFFECT_INTEGRATION_DATABASE_URL: databaseUrl }));
      expect(error).toBeInstanceOf(ChainEvaluationOptionError);
      expect(error).toMatchObject({ code: "CHAIN_EVAL_MODE_INVALID" });
    }
  });

  it("refuses live mode with a typed error instead of pretending to run", () => {
    const error = failureOf(() => resolveChainEvaluationPlan(["--mode", "live"], { SIDE_EFFECT_INTEGRATION_DATABASE_URL: databaseUrl }));

    expect(error).toMatchObject({ code: "CHAIN_EVAL_LIVE_NOT_IMPLEMENTED" });
    expect(String((error as Error).message)).toMatch(/Master/u);
  });

  it("fails closed without the database and never echoes a connection string", () => {
    const missing = failureOf(() => resolveChainEvaluationPlan(["--mode", "deterministic"], {}));
    const invalidDate = failureOf(() =>
      resolveChainEvaluationPlan(["--mode", "deterministic", "--date", "yesterday"], { SIDE_EFFECT_INTEGRATION_DATABASE_URL: databaseUrl })
    );

    expect(missing).toMatchObject({ code: "CHAIN_EVAL_DATABASE_UNAVAILABLE" });
    expect(invalidDate).toMatchObject({ code: "CHAIN_EVAL_DATE_INVALID" });
    expect(String((invalidDate as Error).message)).not.toContain("secret");
  });
});
