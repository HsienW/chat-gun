import { describe, expect, it, vi } from "vitest";

import { createSubjectRightsHttpApp } from "./subject-rights-http.js";
import type { SubjectRightWorkflow } from "./contracts.js";
import { SubjectRightsDeniedError } from "./deletion-coordinator.js";
import { SubjectRightWorkflowError } from "./subject-right-workflow.js";
import {
  configureSubjectRightsHttp,
  createOperationsHttpApp,
  operationsHttpApp,
} from "../../operations/http-app.js";
import { projectRuntimeHealth } from "../../operations/metrics/health.js";

const token = "internal-token-at-least-sixteen";
const workflow: SubjectRightWorkflow = {
  schemaVersion: "1.0.0" as const,
  workflowId: "workflow_01",
  type: "export" as const,
  subject: {
    accountId: "account_01",
    tenantId: "tenant_01",
    principalId: "principal_01",
  },
  status: "completed" as const,
  deadline: "2026-10-01T00:00:00.000Z",
  completedStoreIds: ["runtime.tasks"],
  retryableStoreIds: [],
  createdAt: "2026-09-30T00:00:00.000Z",
  updatedAt: "2026-09-30T00:00:00.000Z",
};

const requestedWorkflow = {
  ...workflow,
  status: "requested" as const,
  completedStoreIds: [],
};

function fixture() {
  const workflows = {
    requestExport: vi.fn(async () => requestedWorkflow),
    requestDeletion: vi.fn(async () => ({ ...requestedWorkflow, type: "deletion" as const })),
    runExport: vi.fn(async () => workflow),
    runDeletion: vi.fn(async () => ({ ...workflow, type: "deletion" as const })),
    getWorkflow: vi.fn(async () => workflow),
  };
  const consent = {
    record: vi.fn(async () => ({
      schemaVersion: "1.0.0" as const,
      consentId: "consent_01",
      accountId: "account_01",
      policyVersion: 1,
      status: "granted" as const,
      scope: "personalization" as const,
      recordedAt: "2026-09-30T00:00:00.000Z",
    })),
  };
  return { workflows, consent, app: createSubjectRightsHttpApp({ serviceToken: token, workflows, consent }) };
}

describe("subject-right internal HTTP boundary", () => {
  it("rejects missing service authentication before workflow execution", async () => {
    const { app, workflows } = fixture();
    const response = await app.request("/deletion", { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
    expect(workflows.requestDeletion).not.toHaveBeenCalled();
  });

  it("persists an authenticated export request without running it inline", async () => {
    const { app, workflows } = fixture();
    const response = await app.request("/export", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-service-token": token,
      },
      body: JSON.stringify({
        workflowId: "workflow_01",
        subject: workflow.subject,
        deadline: workflow.deadline,
        idempotencyKey: "idem_01",
      }),
    });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      workflowId: "workflow_01",
      status: "requested",
    });
    expect(workflows.requestExport).toHaveBeenCalledWith(
      expect.objectContaining({ subject: workflow.subject }),
      workflow.subject,
    );
    expect(workflows.runExport).not.toHaveBeenCalled();
  });

  it("runs a persisted export through the independent authenticated trigger", async () => {
    const { app, workflows } = fixture();
    const response = await app.request("/workflow/workflow_01/run", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-service-token": token,
      },
      body: JSON.stringify({ subject: workflow.subject }),
    });
    expect(response.status).toBe(200);
    expect(workflows.runExport).toHaveBeenCalledWith("workflow_01", workflow.subject);
    expect(workflows.runDeletion).not.toHaveBeenCalled();
  });

  it("runs a persisted deletion through the independent authenticated trigger", async () => {
    const { app, workflows } = fixture();
    workflows.getWorkflow.mockResolvedValueOnce({
      ...workflow,
      type: "deletion" as const,
    });
    const response = await app.request("/workflow/workflow_01/run", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-service-token": token,
      },
      body: JSON.stringify({ subject: workflow.subject }),
    });
    expect(response.status).toBe(200);
    expect(workflows.runDeletion).toHaveBeenCalledWith("workflow_01", workflow.subject);
    expect(workflows.runExport).not.toHaveBeenCalled();
  });

  it("maps workflow and authorization failures to safe typed HTTP errors", async () => {
    const { app, workflows } = fixture();
    workflows.getWorkflow.mockRejectedValueOnce(
      new SubjectRightWorkflowError("WORKFLOW_NOT_FOUND"),
    );
    const missing = await app.request("/workflow/missing", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-service-token": token,
      },
      body: JSON.stringify({ subject: workflow.subject }),
    });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({
      error: {
        code: "WORKFLOW_NOT_FOUND",
        message: "Subject-right workflow was not found",
      },
    });

    workflows.requestDeletion.mockRejectedValueOnce(
      new SubjectRightsDeniedError("CROSS_TENANT_DENIED"),
    );
    const denied = await app.request("/deletion", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-service-token": token,
      },
      body: JSON.stringify({
        workflowId: "workflow_02",
        subject: workflow.subject,
        deadline: workflow.deadline,
      }),
    });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toEqual({
      error: {
        code: "CROSS_TENANT_DENIED",
        message: "Subject-right access denied",
      },
    });
  });

  it("is mounted under the operations internal route", async () => {
    const { workflows, consent } = fixture();
    configureSubjectRightsHttp({ serviceToken: token, workflows, consent });
    try {
      const response = await operationsHttpApp.request(
        "/internal/subject-rights/export",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-internal-service-token": token,
          },
          body: JSON.stringify({
            workflowId: "workflow_01",
            subject: workflow.subject,
            deadline: workflow.deadline,
          }),
        },
      );
      expect(response.status).toBe(202);
    } finally {
      configureSubjectRightsHttp(undefined);
    }
  });

  it("mounts subject rights alongside injected health probes", async () => {
    const { workflows, consent } = fixture();
    const app = createOperationsHttpApp({
      healthProbe: () =>
        projectRuntimeHealth({
          observedAt: "2026-10-03T00:00:00.000Z",
          stuckRunAfterMs: 1_000,
          heartbeatStaleAfterMs: 1_000,
          processAlive: true,
        }),
      subjectRightsProvider: () => ({ serviceToken: token, workflows, consent }),
    });

    const healthResponse = await app.request("/health/live");
    const exportResponse = await app.request(
      "/internal/subject-rights/export",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-service-token": token,
        },
        body: JSON.stringify({
          workflowId: "workflow_01",
          subject: workflow.subject,
          deadline: workflow.deadline,
        }),
      },
    );

    expect(healthResponse.status).toBe(200);
    expect(exportResponse.status).toBe(202);
  });
});
