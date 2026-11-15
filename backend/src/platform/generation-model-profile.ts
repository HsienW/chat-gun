/** Shared Qwen generation default; explicit purpose and caller settings take precedence. */
export const DEFAULT_GENERATION_MODEL = "qwen3.5-flash" as const;

export type DefaultGenerationModel = typeof DEFAULT_GENERATION_MODEL;
