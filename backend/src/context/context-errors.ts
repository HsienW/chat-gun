export type ContextErrorCode =
  | "context_p0_overflow"
  | "context_hard_limit_overflow"
  | "context_config_invalid";

export class ContextHardLimitError extends Error {
  readonly name = "ContextHardLimitError";

  constructor(
    readonly code: ContextErrorCode,
    message: string,
    readonly details: Readonly<Record<string, number | string | boolean>> = {}
  ) {
    super(message);
  }
}

export function isContextHardLimitError(
  error: unknown
): error is ContextHardLimitError {
  return error instanceof ContextHardLimitError;
}
