import { timingSafeEqual } from "node:crypto";

import { Hono } from "hono";

import {
  DATA_INVENTORY_SCHEMA_VERSION,
  type ConsentRecord,
  type SubjectIdentity,
  type SubjectRightWorkflow,
} from "./contracts.js";
import { SubjectRightsDeniedError } from "./deletion-coordinator.js";
import { SubjectRightWorkflowError } from "./subject-right-workflow.js";

export interface SubjectRightsWorkflowPort {
  requestExport(
    request: {
      schemaVersion: typeof DATA_INVENTORY_SCHEMA_VERSION;
      workflowId: string;
      subject: SubjectIdentity;
      deadline: string;
      idempotencyKey?: string;
    },
    actor: SubjectIdentity,
  ): Promise<SubjectRightWorkflow>;
  requestDeletion(
    request: {
      schemaVersion: typeof DATA_INVENTORY_SCHEMA_VERSION;
      workflowId: string;
      subject: SubjectIdentity;
      deadline: string;
      idempotencyKey?: string;
    },
    actor: SubjectIdentity,
  ): Promise<SubjectRightWorkflow>;
  runExport(workflowId: string, actor: SubjectIdentity): Promise<SubjectRightWorkflow>;
  runDeletion(workflowId: string, actor: SubjectIdentity): Promise<SubjectRightWorkflow>;
  getWorkflow(workflowId: string, actor: SubjectIdentity): Promise<SubjectRightWorkflow>;
}

export interface SubjectRightsConsentPort {
  record(input: unknown): Promise<ConsentRecord>;
}

type Dependencies = {
  serviceToken: string;
  workflows: SubjectRightsWorkflowPort;
  consent: SubjectRightsConsentPort;
  now?: () => Date;
};

function authorized(actual: string | undefined, expected: string): boolean {
  if (!actual || expected.length < 16) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseSubject(value: unknown): SubjectIdentity | undefined {
  if (!isRecord(value)) return undefined;
  const { accountId, tenantId, principalId } = value;
  return typeof accountId === "string" &&
    typeof tenantId === "string" &&
    typeof principalId === "string" &&
    accountId.length > 0 && tenantId.length > 0 && principalId.length > 0
    ? { accountId, tenantId, principalId }
    : undefined;
}

export function createSubjectRightsHttpApp(dependencies: Dependencies): Hono {
  const app = new Hono();
  app.onError((error, context) => {
    if (error instanceof SubjectRightsDeniedError) {
      return context.json({
        error: { code: error.code, message: "Subject-right access denied" },
      }, 403);
    }
    if (error instanceof SubjectRightWorkflowError) {
      if (error.code === "WORKFLOW_NOT_FOUND") {
        return context.json({
          error: { code: error.code, message: "Subject-right workflow was not found" },
        }, 404);
      }
      if (error.code === "EXPORT_LINK_EXPIRED") {
        return context.json({
          error: { code: error.code, message: "Export link has expired" },
        }, 410);
      }
      return context.json({
        error: { code: error.code, message: "Subject-right workflow conflicts with the request" },
      }, 409);
    }
    return context.json({
      error: {
        code: "STORE_UNAVAILABLE",
        message: "Subject-right service is temporarily unavailable",
      },
    }, 503);
  });
  app.use("*", async (context, next) => {
    if (!authorized(context.req.header("x-internal-service-token"), dependencies.serviceToken)) {
      return context.json({
        error: { code: "INTERNAL_AUTH_REQUIRED", message: "Internal authentication required" },
      }, 401);
    }
    await next();
  });

  app.post("/export", async (context) => {
    const body: unknown = await context.req.json().catch(() => undefined);
    if (!isRecord(body)) return context.json({ error: { code: "INVALID_REQUEST" } }, 400);
    const subject = parseSubject(body.subject);
    if (!subject || typeof body.workflowId !== "string" || typeof body.deadline !== "string") {
      return context.json({ error: { code: "INVALID_REQUEST" } }, 400);
    }
    const request = {
      schemaVersion: DATA_INVENTORY_SCHEMA_VERSION,
      workflowId: body.workflowId,
      subject,
      deadline: body.deadline,
      ...(typeof body.idempotencyKey === "string"
        ? { idempotencyKey: body.idempotencyKey }
        : {}),
    };
    return context.json(
      await dependencies.workflows.requestExport(request, subject),
      202,
    );
  });

  app.post("/deletion", async (context) => {
    const body: unknown = await context.req.json().catch(() => undefined);
    if (!isRecord(body)) return context.json({ error: { code: "INVALID_REQUEST" } }, 400);
    const subject = parseSubject(body.subject);
    if (!subject || typeof body.workflowId !== "string" || typeof body.deadline !== "string") {
      return context.json({ error: { code: "INVALID_REQUEST" } }, 400);
    }
    const request = {
      schemaVersion: DATA_INVENTORY_SCHEMA_VERSION,
      workflowId: body.workflowId,
      subject,
      deadline: body.deadline,
      ...(typeof body.idempotencyKey === "string"
        ? { idempotencyKey: body.idempotencyKey }
        : {}),
    };
    return context.json(
      await dependencies.workflows.requestDeletion(request, subject),
      202,
    );
  });

  app.post("/consent", async (context) => {
    const body: unknown = await context.req.json().catch(() => undefined);
    if (!isRecord(body)) return context.json({ error: { code: "INVALID_REQUEST" } }, 400);
    const record = await dependencies.consent.record({
      ...body,
      schemaVersion: "1.0.0",
      recordedAt:
        typeof body.recordedAt === "string"
          ? body.recordedAt
          : (dependencies.now ?? (() => new Date()))().toISOString(),
    });
    return context.json({
      schemaVersion: "1.0.0",
      workflowId: record.consentId,
      type: "consent",
      status: "completed",
    }, 202);
  });

  app.post("/workflow/:workflowId/run", async (context) => {
    const body: unknown = await context.req.json().catch(() => undefined);
    const subject = isRecord(body) ? parseSubject(body.subject) : undefined;
    if (!subject) return context.json({ error: { code: "INVALID_REQUEST" } }, 400);
    const workflowId = context.req.param("workflowId");
    const workflow = await dependencies.workflows.getWorkflow(workflowId, subject);
    if (workflow.type === "export") {
      return context.json(
        await dependencies.workflows.runExport(workflowId, subject),
        200,
      );
    }
    if (workflow.type === "deletion") {
      return context.json(
        await dependencies.workflows.runDeletion(workflowId, subject),
        200,
      );
    }
    throw new SubjectRightWorkflowError("WORKFLOW_TYPE_MISMATCH");
  });

  app.post("/workflow/:workflowId", async (context) => {
    const body: unknown = await context.req.json().catch(() => undefined);
    const subject = isRecord(body) ? parseSubject(body.subject) : undefined;
    if (!subject) return context.json({ error: { code: "INVALID_REQUEST" } }, 400);
    return context.json(
      await dependencies.workflows.getWorkflow(context.req.param("workflowId"), subject),
      200,
    );
  });
  return app;
}
