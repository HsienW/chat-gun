import { z } from "zod";

const identifierSchema = z.string().trim().min(1).max(256);
const versionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/);
const graphConfigHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const INTERRUPT_MANIFEST_STATUSES = [
  "waiting",
  "resumed",
  "expired",
  "superseded",
  "rejected",
] as const;

export const executionManifestRefSchema = z
  .object({
    manifestVersion: versionSchema,
    graphId: identifierSchema,
    graphConfigHash: graphConfigHashSchema,
    deploymentVersion: identifierSchema.optional(),
    schemaVersions: z
      .object({
        runtimeEventEnvelope: versionSchema,
        toolDescriptor: versionSchema,
        authorizationPolicy: versionSchema,
        normalizedInput: versionSchema,
      })
      .strict(),
  })
  .strict();

const manifestBase = {
  interruptId: identifierSchema,
  runId: identifierSchema,
  threadId: identifierSchema,
  taskId: identifierSchema,
  stepId: identifierSchema.optional(),
  scopeId: identifierSchema,
  expectedResponseSchemaRef: identifierSchema,
  expiryAt: z.string().datetime({ offset: true }),
  executionManifest: executionManifestRefSchema,
  status: z.enum(INTERRUPT_MANIFEST_STATUSES),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
};

export const durableInterruptManifestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...manifestBase,
      kind: z.literal("confirmation"),
      decisionRef: z
        .object({
          decisionId: identifierSchema,
          approvalId: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...manifestBase,
      kind: z.literal("clarification"),
    })
    .strict(),
]);

export type ExecutionManifestRef = z.infer<typeof executionManifestRefSchema>;
export type DurableInterruptManifest = z.infer<
  typeof durableInterruptManifestSchema
>;
export type InterruptManifestStatus =
  (typeof INTERRUPT_MANIFEST_STATUSES)[number];

export function parseDurableInterruptManifest(
  value: unknown
): DurableInterruptManifest {
  return durableInterruptManifestSchema.parse(value);
}
