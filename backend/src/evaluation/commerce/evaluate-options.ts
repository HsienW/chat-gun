/**
 * Arguments of `npm run commerce:evaluate` (design §20.7, decision point 3).
 * Only the deterministic layer can run here; live mode needs a model and a
 * knowledge database that the Master provides, so it is refused explicitly.
 */
export type ChainEvaluationOptionErrorCode =
  | "CHAIN_EVAL_MODE_INVALID"
  | "CHAIN_EVAL_LIVE_NOT_IMPLEMENTED"
  | "CHAIN_EVAL_DATABASE_UNAVAILABLE"
  | "CHAIN_EVAL_DATE_INVALID";

export class ChainEvaluationOptionError extends Error {
  readonly name = "ChainEvaluationOptionError";

  constructor(readonly code: ChainEvaluationOptionErrorCode, message: string) {
    super(message);
  }
}

export interface DeterministicChainEvaluationPlan {
  mode: "deterministic";
  databaseUrl: string;
  /** YYYY-MM-DD; names the result directory. */
  date: string;
}

function argument(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

export function resolveChainEvaluationPlan(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  today: () => string = () => new Date().toISOString().slice(0, 10)
): DeterministicChainEvaluationPlan {
  const mode = argument(argv, "--mode");
  if (mode === "live") {
    throw new ChainEvaluationOptionError(
      "CHAIN_EVAL_LIVE_NOT_IMPLEMENTED",
      "Live chain evaluation is not implemented: it needs the model and knowledge database the Master provides (tasks T11)."
    );
  }
  if (mode !== "deterministic") {
    throw new ChainEvaluationOptionError("CHAIN_EVAL_MODE_INVALID", "--mode must be deterministic or live");
  }
  const date = argument(argv, "--date") ?? today();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    throw new ChainEvaluationOptionError("CHAIN_EVAL_DATE_INVALID", "--date must be YYYY-MM-DD");
  }
  // The isolated database of the side-effect integration tests; its value is never printed.
  const databaseUrl = env.SIDE_EFFECT_INTEGRATION_DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new ChainEvaluationOptionError(
      "CHAIN_EVAL_DATABASE_UNAVAILABLE",
      "Deterministic chain evaluation needs SIDE_EFFECT_INTEGRATION_DATABASE_URL (an isolated Postgres)"
    );
  }
  return { mode: "deterministic", databaseUrl, date };
}
