import { z } from "zod";

import { confirmationResumeSchema } from "../authorization/confirmation.js";
import { WEATHER_CLARIFICATION_RESPONSE_SCHEMA_REF } from "./clarification-manifest.js";

const weatherClarificationResumeSchema = z.union([
  z.string().trim().min(1).max(100_000),
  z.object({ userReply: z.string().trim().min(1).max(100_000) }).strict(),
  z.object({ cancel: z.literal(true) }).strict(),
]);

export type ResumeResponseValidation =
  | { ok: true; value: unknown }
  | { ok: false; reasonCode: "UNKNOWN_RESPONSE_SCHEMA" | "INVALID_RESPONSE" };

export interface ResumeResponseSchemaRegistry {
  validate(schemaRef: string, value: unknown): ResumeResponseValidation;
}

export function createResumeResponseSchemaRegistry(
  extensions: ReadonlyMap<string, z.ZodType> = new Map()
): ResumeResponseSchemaRegistry {
  const schemas = new Map<string, z.ZodType>([
    [WEATHER_CLARIFICATION_RESPONSE_SCHEMA_REF, weatherClarificationResumeSchema],
    ["tool_authorization_confirmation@1.0", confirmationResumeSchema],
    ...extensions,
  ]);
  return {
    validate(schemaRef, value) {
      const schema = schemas.get(schemaRef);
      if (!schema) return { ok: false, reasonCode: "UNKNOWN_RESPONSE_SCHEMA" };
      const parsed = schema.safeParse(value);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, reasonCode: "INVALID_RESPONSE" };
    },
  };
}
