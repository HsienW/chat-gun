export const KNOWLEDGE_ERROR_CODES = [
  "KB_EMBEDDING_UNSUPPORTED",
  "KB_RERANK_UNSUPPORTED",
  "KB_PROVIDER_TIMEOUT",
  "KB_PROVIDER_RATE_LIMITED",
  "KB_PROVIDER_ERROR",
  "KB_EMBEDDING_DIMENSION_MISMATCH",
  "KB_EMBEDDING_INPUT_TOO_LARGE",
  "KB_RERANK_UNAVAILABLE",
  "KB_STORE_UNAVAILABLE",
  "KB_EMBEDDING_SPACE_MISMATCH",
  "KB_CONFIG_INVALID",
  "KB_SOURCE_PROVENANCE_MISSING",
  "KB_SOURCE_EMPTY",
  "KB_SOURCE_TOO_LARGE",
  "KB_CANCELLED",
  "SECRET_REFERENCE_UNRESOLVABLE",
  "EGRESS_DENIED",
] as const;

export type KnowledgeErrorCode = (typeof KNOWLEDGE_ERROR_CODES)[number];

/** Retryable failures may be retried by the existing resilience policy; others are terminal. */
const RETRYABLE_CODES: ReadonlySet<KnowledgeErrorCode> = new Set([
  "KB_PROVIDER_TIMEOUT",
  "KB_PROVIDER_RATE_LIMITED",
  "KB_STORE_UNAVAILABLE",
]);

export class KnowledgeError extends Error {
  readonly name = "KnowledgeError";
  readonly retryable: boolean;

  constructor(readonly code: KnowledgeErrorCode, message: string = code) {
    super(message);
    this.retryable = RETRYABLE_CODES.has(code);
  }
}

export function isKnowledgeError(error: unknown): error is KnowledgeError {
  return error instanceof KnowledgeError;
}
