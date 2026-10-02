import {
  DATA_INVENTORY_SCHEMA_VERSION,
  SUBJECT_RIGHT_WORKFLOW_SCHEMA_VERSION,
  deletionReceiptSchema,
  exportPartResultSchema,
  subjectRightWorkflowSchema,
  validateSubjectDataRequest,
  type DeletionPartResult,
  type DeletionReceipt,
  type ExportPartResult,
  type SubjectDataRequest,
  type SubjectIdentity,
  type SubjectRightWorkflow,
} from "./contracts.js";
import {
  assertSubjectRightsAccess,
  DeletionCoordinator,
} from "./deletion-coordinator.js";
import { DataInventoryRegistry } from "./registry.js";
import type { Queryable } from "../persistence/rows.js";

export type SubjectRightWorkflowErrorCode =
  | "WORKFLOW_NOT_FOUND"
  | "WORKFLOW_TYPE_MISMATCH"
  | "WORKFLOW_ID_CONFLICT"
  | "EXPORT_LINK_EXPIRED";

export class SubjectRightWorkflowError extends Error {
  constructor(readonly code: SubjectRightWorkflowErrorCode) {
    super(code);
    this.name = "SubjectRightWorkflowError";
  }
}

export interface SubjectRightWorkflowRepository {
  getWorkflow(workflowId: string): Promise<SubjectRightWorkflow | undefined>;
  saveWorkflow(workflow: SubjectRightWorkflow): Promise<void>;
  listDeletionParts(workflowId: string): Promise<DeletionPartResult[]>;
  saveDeletionPart(workflowId: string, part: DeletionPartResult): Promise<void>;
  listExportParts(workflowId: string): Promise<ExportPartResult[]>;
  saveExportPart(workflowId: string, part: ExportPartResult): Promise<void>;
  getReceipt(workflowId: string): Promise<DeletionReceipt | undefined>;
  saveReceipt(receipt: DeletionReceipt): Promise<void>;
}

export function createInMemorySubjectRightWorkflowRepository(): SubjectRightWorkflowRepository {
  const workflows = new Map<string, SubjectRightWorkflow>();
  const deletionParts = new Map<string, Map<string, DeletionPartResult>>();
  const exportParts = new Map<string, Map<string, ExportPartResult>>();
  const receipts = new Map<string, DeletionReceipt>();
  return {
    async getWorkflow(workflowId) {
      return workflows.get(workflowId);
    },
    async saveWorkflow(workflow) {
      workflows.set(workflow.workflowId, subjectRightWorkflowSchema.parse(workflow));
    },
    async listDeletionParts(workflowId) {
      return [...(deletionParts.get(workflowId)?.values() ?? [])];
    },
    async saveDeletionPart(workflowId, part) {
      const parts = deletionParts.get(workflowId) ?? new Map();
      parts.set(part.storeId, part);
      deletionParts.set(workflowId, parts);
    },
    async listExportParts(workflowId) {
      return [...(exportParts.get(workflowId)?.values() ?? [])];
    },
    async saveExportPart(workflowId, part) {
      const parts = exportParts.get(workflowId) ?? new Map();
      parts.set(part.storeId, part);
      exportParts.set(workflowId, parts);
    },
    async getReceipt(workflowId) {
      return receipts.get(workflowId);
    },
    async saveReceipt(receipt) {
      receipts.set(receipt.workflowId, deletionReceiptSchema.parse(receipt));
    },
  };
}

type WorkflowRow = Record<string, unknown> & {
  workflow_id: string;
  workflow_type: string;
  account_id: string;
  tenant_id: string;
  principal_id: string;
  status: string;
  deadline: string | Date;
  completed_store_ids: unknown;
  retryable_store_ids: unknown;
  deletion_parts: unknown;
  export_parts: unknown;
  created_at: string | Date;
  updated_at: string | Date;
};

type ReceiptRow = Record<string, unknown> & {
  receipt_id: string;
  workflow_id: string;
  result_parts: unknown;
  verification_parts: unknown;
  created_at: string | Date;
  updated_at: string | Date;
};

function valuesOfRecord(value: unknown): unknown[] {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.values(value)
    : [];
}

function workflowFromRow(row: WorkflowRow): SubjectRightWorkflow {
  return subjectRightWorkflowSchema.parse({
    schemaVersion: SUBJECT_RIGHT_WORKFLOW_SCHEMA_VERSION,
    workflowId: row.workflow_id,
    type: row.workflow_type,
    subject: {
      accountId: row.account_id,
      tenantId: row.tenant_id,
      principalId: row.principal_id,
    },
    status: row.status,
    deadline: new Date(row.deadline).toISOString(),
    completedStoreIds: row.completed_store_ids,
    retryableStoreIds: row.retryable_store_ids,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  });
}

export class PgSubjectRightWorkflowRepository implements SubjectRightWorkflowRepository {
  constructor(private readonly database: Queryable) {}

  async getWorkflow(workflowId: string) {
    const result = await this.database.query<WorkflowRow>(
      `SELECT workflow_id, workflow_type, account_id, tenant_id, principal_id,
              status, deadline, completed_store_ids, retryable_store_ids,
              deletion_parts, export_parts, created_at, updated_at
       FROM subject_right_workflows WHERE workflow_id = $1`,
      [workflowId],
    );
    return result.rows[0] ? workflowFromRow(result.rows[0]) : undefined;
  }

  async saveWorkflow(workflow: SubjectRightWorkflow): Promise<void> {
    const value = subjectRightWorkflowSchema.parse(workflow);
    await this.database.query(
      `INSERT INTO subject_right_workflows
         (workflow_id, workflow_type, account_id, tenant_id, principal_id, status,
          deadline, completed_store_ids, retryable_store_ids, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11)
       ON CONFLICT (workflow_id) DO UPDATE SET status = EXCLUDED.status,
         completed_store_ids = EXCLUDED.completed_store_ids,
         retryable_store_ids = EXCLUDED.retryable_store_ids,
         updated_at = EXCLUDED.updated_at`,
      [value.workflowId, value.type, value.subject.accountId, value.subject.tenantId,
        value.subject.principalId, value.status, value.deadline,
        JSON.stringify(value.completedStoreIds), JSON.stringify(value.retryableStoreIds),
        value.createdAt, value.updatedAt],
    );
  }

  private async listParts(workflowId: string, column: "deletion_parts" | "export_parts") {
    const result = await this.database.query<Record<string, unknown>>(
      `SELECT ${column} FROM subject_right_workflows WHERE workflow_id = $1`,
      [workflowId],
    );
    return valuesOfRecord(result.rows[0]?.[column]);
  }

  async listDeletionParts(workflowId: string) {
    return (await this.listParts(workflowId, "deletion_parts")).map((part) =>
      deletionReceiptSchema.shape.parts.element.parse(part),
    );
  }

  async saveDeletionPart(workflowId: string, part: DeletionPartResult): Promise<void> {
    await this.database.query(
      `UPDATE subject_right_workflows
       SET deletion_parts = jsonb_set(deletion_parts, ARRAY[$2], $3::jsonb, true),
           updated_at = NOW()
       WHERE workflow_id = $1`,
      [workflowId, part.storeId, JSON.stringify(part)],
    );
  }

  async listExportParts(workflowId: string) {
    return (await this.listParts(workflowId, "export_parts")).map((part) =>
      exportPartResultSchema.parse(part),
    );
  }

  async saveExportPart(workflowId: string, part: ExportPartResult): Promise<void> {
    await this.database.query(
      `UPDATE subject_right_workflows
       SET export_parts = jsonb_set(export_parts, ARRAY[$2], $3::jsonb, true),
           updated_at = NOW()
       WHERE workflow_id = $1`,
      [workflowId, part.storeId, JSON.stringify(part)],
    );
  }

  async getReceipt(workflowId: string) {
    const result = await this.database.query<ReceiptRow>(
      `SELECT receipt_id, workflow_id, result_parts, verification_parts, created_at, updated_at
       FROM deletion_receipts WHERE workflow_id = $1`,
      [workflowId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const parts = Array.isArray(row.result_parts) ? row.result_parts : [];
    const verification = Array.isArray(row.verification_parts) ? row.verification_parts : [];
    return deletionReceiptSchema.parse({
      schemaVersion: DATA_INVENTORY_SCHEMA_VERSION,
      receiptId: row.receipt_id,
      workflowId: row.workflow_id,
      status:
        [...parts, ...verification].some(
          (part) => typeof part === "object" && part !== null && "status" in part && part.status === "failed",
        ) ? "incomplete" : "completed",
      parts,
      verification,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    });
  }

  async saveReceipt(receipt: DeletionReceipt): Promise<void> {
    const value = deletionReceiptSchema.parse(receipt);
    await this.database.query(
      `INSERT INTO deletion_receipts
         (receipt_id, workflow_id, result_parts, verification_parts, created_at, updated_at)
       VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6)
       ON CONFLICT (receipt_id) DO UPDATE SET result_parts = EXCLUDED.result_parts,
         verification_parts = EXCLUDED.verification_parts,
         updated_at = EXCLUDED.updated_at`,
      [value.receiptId, value.workflowId, JSON.stringify(value.parts),
        JSON.stringify(value.verification), value.createdAt, value.updatedAt],
    );
  }
}

type SubjectRightWorkflowServiceOptions = {
  now?: () => Date;
  maxConcurrency?: number;
};

function sameSubject(left: SubjectIdentity, right: SubjectIdentity): boolean {
  return left.accountId === right.accountId &&
    left.tenantId === right.tenantId &&
    left.principalId === right.principalId;
}

export class SubjectRightWorkflowService {
  private readonly now: () => Date;
  private readonly deletionCoordinator: DeletionCoordinator;

  constructor(
    private readonly registry: DataInventoryRegistry,
    private readonly repository: SubjectRightWorkflowRepository,
    options: SubjectRightWorkflowServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.deletionCoordinator = new DeletionCoordinator(registry, {
      maxConcurrency: options.maxConcurrency,
      now: this.now,
    });
  }

  private async requestWorkflow(
    input: SubjectDataRequest,
    actor: SubjectIdentity,
    type: "export" | "deletion",
  ): Promise<SubjectRightWorkflow> {
    const request = validateSubjectDataRequest(input);
    assertSubjectRightsAccess(request.subject, actor);
    const existing = await this.repository.getWorkflow(request.workflowId);
    if (existing) {
      if (existing.type !== type || !sameSubject(existing.subject, request.subject)) {
        throw new SubjectRightWorkflowError("WORKFLOW_ID_CONFLICT");
      }
      return existing;
    }
    const timestamp = this.now().toISOString();
    const workflow = subjectRightWorkflowSchema.parse({
      schemaVersion: SUBJECT_RIGHT_WORKFLOW_SCHEMA_VERSION,
      workflowId: request.workflowId,
      type,
      subject: request.subject,
      status: "requested",
      deadline: request.deadline,
      completedStoreIds: [],
      retryableStoreIds: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.repository.saveWorkflow(workflow);
    return workflow;
  }

  requestDeletion(
    input: SubjectDataRequest,
    actor: SubjectIdentity,
  ): Promise<SubjectRightWorkflow> {
    return this.requestWorkflow(input, actor, "deletion");
  }

  requestExport(
    input: SubjectDataRequest,
    actor: SubjectIdentity,
  ): Promise<SubjectRightWorkflow> {
    return this.requestWorkflow(input, actor, "export");
  }

  private async requireWorkflow(
    workflowId: string,
    actor: SubjectIdentity,
    expectedType?: SubjectRightWorkflow["type"],
  ): Promise<SubjectRightWorkflow> {
    const workflow = await this.repository.getWorkflow(workflowId);
    if (!workflow) throw new SubjectRightWorkflowError("WORKFLOW_NOT_FOUND");
    assertSubjectRightsAccess(workflow.subject, actor);
    if (expectedType && workflow.type !== expectedType) {
      throw new SubjectRightWorkflowError("WORKFLOW_TYPE_MISMATCH");
    }
    return workflow;
  }

  private async saveProgress(
    workflow: SubjectRightWorkflow,
    completedStoreIds: string[],
    retryableStoreIds: string[],
  ): Promise<SubjectRightWorkflow> {
    const updated = subjectRightWorkflowSchema.parse({
      ...workflow,
      status: retryableStoreIds.length === 0 ? "completed" : "failed",
      completedStoreIds,
      retryableStoreIds,
      updatedAt: this.now().toISOString(),
    });
    await this.repository.saveWorkflow(updated);
    return updated;
  }

  async runDeletion(
    workflowId: string,
    actor: SubjectIdentity,
  ): Promise<SubjectRightWorkflow> {
    const workflow = await this.requireWorkflow(workflowId, actor, "deletion");
    const inProgress = subjectRightWorkflowSchema.parse({
      ...workflow,
      status: "in_progress",
      updatedAt: this.now().toISOString(),
    });
    await this.repository.saveWorkflow(inProgress);
    const priorParts = await this.repository.listDeletionParts(workflowId);
    const receipt = await this.deletionCoordinator.delete(
      {
        schemaVersion: DATA_INVENTORY_SCHEMA_VERSION,
        workflowId,
        subject: workflow.subject,
        deadline: workflow.deadline,
      },
      actor,
      {
        priorParts,
        onPart: (part) => this.repository.saveDeletionPart(workflowId, part),
      },
    );
    await this.repository.saveReceipt(receipt);
    return this.saveProgress(
      inProgress,
      receipt.parts
        .filter((part) => part.status !== "failed")
        .map((part) => part.storeId),
      receipt.parts
        .filter((part) => part.status === "failed" && part.retryable)
        .map((part) => part.storeId),
    );
  }

  async verifyDeletion(
    workflowId: string,
    actor: SubjectIdentity,
  ): Promise<DeletionReceipt> {
    const workflow = await this.requireWorkflow(workflowId, actor, "deletion");
    const existingReceipt = await this.repository.getReceipt(workflowId);
    if (!existingReceipt) {
      throw new SubjectRightWorkflowError("WORKFLOW_NOT_FOUND");
    }
    const verification = await Promise.all(
      this.registry.listStores().map((store) =>
        store.verifySubjectDeletion({
          schemaVersion: DATA_INVENTORY_SCHEMA_VERSION,
          workflowId,
          subject: workflow.subject,
          deadline: workflow.deadline,
          receiptId: existingReceipt.receiptId,
        }),
      ),
    );
    const receipt = deletionReceiptSchema.parse({
      ...existingReceipt,
      status:
        existingReceipt.parts.some((part) => part.status === "failed") ||
        verification.some((part) => part.status === "failed")
          ? "incomplete"
          : "completed",
      verification,
      updatedAt: this.now().toISOString(),
    });
    await this.repository.saveReceipt(receipt);
    await this.saveProgress(
      workflow,
      receipt.parts.filter((part) => part.status !== "failed").map((part) => part.storeId),
      [
        ...receipt.parts.filter((part) => part.status === "failed").map((part) => part.storeId),
        ...verification.filter((part) => part.status === "failed").map((part) => part.storeId),
      ],
    );
    return receipt;
  }

  async runExport(
    workflowId: string,
    actor: SubjectIdentity,
  ): Promise<SubjectRightWorkflow> {
    const workflow = await this.requireWorkflow(workflowId, actor, "export");
    const inProgress = subjectRightWorkflowSchema.parse({
      ...workflow,
      status: "in_progress",
      updatedAt: this.now().toISOString(),
    });
    await this.repository.saveWorkflow(inProgress);
    const previous = new Map(
      (await this.repository.listExportParts(workflowId)).map((part) => [part.storeId, part]),
    );
    for (const store of this.registry.listStores()) {
      const prior = previous.get(store.id);
      if (prior && prior.status !== "failed") continue;
      let part: ExportPartResult;
      try {
        part = exportPartResultSchema.parse(
          await store.exportSubjectData({
            schemaVersion: DATA_INVENTORY_SCHEMA_VERSION,
            workflowId,
            subject: workflow.subject,
            deadline: workflow.deadline,
          }),
        );
      } catch {
        part = {
          status: "failed",
          storeId: store.id,
          errorCode: "STORE_UNAVAILABLE",
          retryable: true,
        };
      }
      previous.set(store.id, part);
      await this.repository.saveExportPart(workflowId, part);
    }
    const parts = [...previous.values()];
    return this.saveProgress(
      inProgress,
      parts.filter((part) => part.status !== "failed").map((part) => part.storeId),
      parts.filter((part) => part.status === "failed" && part.retryable).map((part) => part.storeId),
    );
  }

  async getExport(
    workflowId: string,
    actor: SubjectIdentity,
  ): Promise<ExportPartResult[]> {
    const workflow = await this.requireWorkflow(workflowId, actor, "export");
    if (Date.parse(workflow.deadline) <= this.now().getTime()) {
      await this.repository.saveWorkflow(subjectRightWorkflowSchema.parse({
        ...workflow,
        status: "expired",
        updatedAt: this.now().toISOString(),
      }));
      throw new SubjectRightWorkflowError("EXPORT_LINK_EXPIRED");
    }
    return this.repository.listExportParts(workflowId);
  }

  getWorkflow(
    workflowId: string,
    actor: SubjectIdentity,
  ): Promise<SubjectRightWorkflow> {
    return this.requireWorkflow(workflowId, actor);
  }
}
