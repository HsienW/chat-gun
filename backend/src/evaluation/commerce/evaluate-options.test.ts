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

  const liveEnv = {
    SIDE_EFFECT_INTEGRATION_DATABASE_URL: databaseUrl,
    KNOWLEDGE_DATABASE_URL: "postgres://user:kb-secret@localhost:5432/kb",
    QWEN_API_KEY: "sk-live-secret",
    SHOPPING_ASSISTANT_MODEL: "model-under-test",
  };

  it("plans a live run when the model, the knowledge database and the runtime database are configured", () => {
    const plan = resolveChainEvaluationPlan(["--mode", "live", "--date", "2026-10-27"], liveEnv);

    expect(plan).toEqual({ mode: "live", databaseUrl, date: "2026-10-27", model: "model-under-test" });
  });

  it("fails live mode closed before running when its environment is incomplete, naming only what is missing", () => {
    for (const missing of Object.keys(liveEnv)) {
      const env: Record<string, string> = { ...liveEnv };
      delete env[missing];
      const error = failureOf(() => resolveChainEvaluationPlan(["--mode", "live"], env));

      expect(error).toBeInstanceOf(ChainEvaluationOptionError);
      expect(error).toMatchObject({ code: "CHAIN_EVAL_LIVE_ENV_INCOMPLETE" });
      const message = String((error as Error).message);
      expect(message).toContain(missing);
      for (const value of Object.values(liveEnv)) expect(message).not.toContain(value);
    }
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
