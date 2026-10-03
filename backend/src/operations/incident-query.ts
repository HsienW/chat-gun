import { z } from "zod";

import { executionIdSchema } from "../runtime/execution-context/execution-context.js";

const incidentReferenceSchema = z
  .object({ reference: z.string().trim().min(1).max(512) })
  .strict();
const incidentEventSchema = z
  .object({
    eventId: executionIdSchema,
    sequence: z.number().int().positive().safe(),
    type: z.string().regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/),
    emittedAt: z.string().datetime(),
    taskId: executionIdSchema,
    stepId: executionIdSchema.optional(),
    toolCallId: executionIdSchema.optional(),
  })
  .strict();
const incidentToolExecutionSchema = z
  .object({
    toolName: z.string().trim().min(1).max(128),
    outcome: z.string().trim().min(1).max(128),
  })
  .strict();

export const incidentProjectionSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    runId: executionIdSchema,
    events: z.array(incidentEventSchema).max(1_000),
    audit: z.array(incidentReferenceSchema).max(1_000),
    traces: z.array(incidentReferenceSchema).max(1_000),
    toolExecutions: z.array(incidentToolExecutionSchema).max(1_000),
    terminalResult: z
      .object({ status: z.string().trim().min(1).max(64) })
      .strict()
      .nullable(),
  })
  .strict();

export type IncidentProjection = z.infer<typeof incidentProjectionSchema>;

export interface IncidentProjectionIndex {
  record(projection: unknown): void;
  query(runId: string): IncidentProjection | null;
  delete(runId: string): void;
}

export interface IncidentFactStore {
  append(projection: IncidentProjection): Promise<void>;
  list(): Promise<readonly IncidentProjection[]>;
}

export interface AuthoritativeIncidentProjection {
  recordAuthoritative(projection: unknown): Promise<{ projected: boolean }>;
  rebuild(): Promise<{ rebuilt: number; failed: number }>;
}

export function createAuthoritativeIncidentProjection(
  factStore: IncidentFactStore,
  index: IncidentProjectionIndex = createIncidentProjectionIndex()
): AuthoritativeIncidentProjection {
  return {
    async recordAuthoritative(value) {
      const projection = incidentProjectionSchema.parse(value);
      await factStore.append(projection);
      try {
        index.record(projection);
        return { projected: true };
      } catch {
        return { projected: false };
      }
    },
    async rebuild() {
      const facts = await factStore.list();
      let rebuilt = 0;
      let failed = 0;
      for (const fact of facts) {
        try {
          index.record(fact);
          rebuilt += 1;
        } catch {
          failed += 1;
        }
      }
      return { rebuilt, failed };
    },
  };
}

export function createInMemoryIncidentFactStore(): IncidentFactStore {
  const facts: IncidentProjection[] = [];
  return {
    async append(projection) {
      facts.push(incidentProjectionSchema.parse(projection));
    },
    async list() {
      return facts.map((fact) => incidentProjectionSchema.parse(fact));
    },
  };
}

const MAX_INDEXED_RUNS = 1_000;

export function createIncidentProjectionIndex(): IncidentProjectionIndex {
  const projections = new Map<string, IncidentProjection>();
  return {
    record(value) {
      const projection = incidentProjectionSchema.parse(value);
      if (!projections.has(projection.runId) && projections.size >= MAX_INDEXED_RUNS) {
        const oldestRunId = projections.keys().next().value;
        if (typeof oldestRunId === "string") projections.delete(oldestRunId);
      }
      projections.delete(projection.runId);
      projections.set(projection.runId, projection);
    },
    query(runId) {
      executionIdSchema.parse(runId);
      const projection = projections.get(runId);
      return projection ? incidentProjectionSchema.parse(projection) : null;
    },
    delete(runId) {
      executionIdSchema.parse(runId);
      projections.delete(runId);
    },
  };
}

const incidentProjectionIndex = createIncidentProjectionIndex();

export function getIncidentProjectionIndex(): IncidentProjectionIndex {
  return incidentProjectionIndex;
}
