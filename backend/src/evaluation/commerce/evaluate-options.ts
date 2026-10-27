import { KB_SEARCH_SECRET_REFERENCE } from "../../tools/kb-search.js";

/**
 * Arguments of `npm run commerce:evaluate` (design §20.5, §20.7, decision point 3).
 * Live mode needs the model, the knowledge database and the runtime database;
 * when any is missing it fails closed before anything is written (design §20.5 B1).
 */
export type ChainEvaluationOptionErrorCode =
  | "CHAIN_EVAL_MODE_INVALID"
  | "CHAIN_EVAL_LIVE_ENV_INCOMPLETE"
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

export interface LiveChainEvaluationPlan {
  mode: "live";
  databaseUrl: string;
  date: string;
  /** Pinned so the provenance names the model that was evaluated. */
  model: string;
}

export type ChainEvaluationPlan = DeterministicChainEvaluationPlan | LiveChainEvaluationPlan;

/** Variables live mode cannot run without; only their names are ever reported. */
const LIVE_REQUIRED_ENV = [
  "SIDE_EFFECT_INTEGRATION_DATABASE_URL",
  "KNOWLEDGE_DATABASE_URL",
  KB_SEARCH_SECRET_REFERENCE.secretName,
  "SHOPPING_ASSISTANT_MODEL",
] as const;

function argument(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

export function resolveChainEvaluationPlan(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  today: () => string = () => new Date().toISOString().slice(0, 10)
): ChainEvaluationPlan {
  const mode = argument(argv, "--mode");
  if (mode !== "deterministic" && mode !== "live") {
    throw new ChainEvaluationOptionError("CHAIN_EVAL_MODE_INVALID", "--mode must be deterministic or live");
  }
  const value = (name: string) => env[name]?.trim() || undefined;
  if (mode === "live") {
    const missing = LIVE_REQUIRED_ENV.filter((name) => value(name) === undefined);
    if (missing.length > 0) {
      throw new ChainEvaluationOptionError("CHAIN_EVAL_LIVE_ENV_INCOMPLETE", `Live chain evaluation needs ${missing.join(", ")}`);
    }
  }
  const date = argument(argv, "--date") ?? today();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    throw new ChainEvaluationOptionError("CHAIN_EVAL_DATE_INVALID", "--date must be YYYY-MM-DD");
  }
  // The isolated database of the side-effect integration tests; its value is never printed.
  const databaseUrl = value("SIDE_EFFECT_INTEGRATION_DATABASE_URL");
  if (!databaseUrl) {
    throw new ChainEvaluationOptionError(
      "CHAIN_EVAL_DATABASE_UNAVAILABLE",
      "Deterministic chain evaluation needs SIDE_EFFECT_INTEGRATION_DATABASE_URL (an isolated Postgres)"
    );
  }
  return mode === "live" ? { mode, databaseUrl, date, model: value("SHOPPING_ASSISTANT_MODEL")! } : { mode, databaseUrl, date };
}
