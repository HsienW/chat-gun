import {
  DATA_INVENTORY_SCHEMA_VERSION,
  deletionPartResultSchema,
  deletionReceiptSchema,
  validateSubjectDeletionRequest,
  type DeletionPartResult,
  type DeletionReceipt,
  type SubjectDeletionRequest,
  type SubjectIdentity,
} from "./contracts.js";
import { DataInventoryRegistry } from "./registry.js";

export type SubjectRightsDenyCode =
  | "CROSS_ACCOUNT_DENIED"
  | "CROSS_TENANT_DENIED"
  | "CROSS_PRINCIPAL_DENIED";

export class SubjectRightsDeniedError extends Error {
  constructor(readonly code: SubjectRightsDenyCode) {
    super(code);
    this.name = "SubjectRightsDeniedError";
  }
}

export function assertSubjectRightsAccess(
  requested: SubjectIdentity,
  actor: SubjectIdentity,
): void {
  if (requested.tenantId !== actor.tenantId) {
    throw new SubjectRightsDeniedError("CROSS_TENANT_DENIED");
  }
  if (requested.accountId !== actor.accountId) {
    throw new SubjectRightsDeniedError("CROSS_ACCOUNT_DENIED");
  }
  if (requested.principalId !== actor.principalId) {
    throw new SubjectRightsDeniedError("CROSS_PRINCIPAL_DENIED");
  }
}

type DeletionCoordinatorOptions = {
  maxConcurrency?: number;
  now?: () => Date;
};

export type DeletionProgressOptions = {
  priorParts?: readonly DeletionPartResult[];
  onPart?: (part: DeletionPartResult) => Promise<void>;
};

export class DeletionCoordinator {
  private readonly maxConcurrency: number;
  private readonly now: () => Date;

  constructor(
    private readonly registry: DataInventoryRegistry,
    options: DeletionCoordinatorOptions = {},
  ) {
    const maxConcurrency = options.maxConcurrency ?? 4;
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 32) {
      throw new Error("INVALID_DELETION_CONCURRENCY");
    }
    this.maxConcurrency = maxConcurrency;
    this.now = options.now ?? (() => new Date());
  }

  async delete(
    input: SubjectDeletionRequest,
    actor: SubjectIdentity,
    progress: DeletionProgressOptions = {},
  ): Promise<DeletionReceipt> {
    const request = validateSubjectDeletionRequest(input);
    assertSubjectRightsAccess(request.subject, actor);
    const stores = this.registry.listStores();
    const partByStoreId = new Map(
      (progress.priorParts ?? []).map((part) => [part.storeId, part]),
    );
    const pendingStores = stores.filter((store) => {
      const prior = partByStoreId.get(store.id);
      return prior === undefined || prior.status === "failed";
    });

    for (let index = 0; index < pendingStores.length; index += this.maxConcurrency) {
      const batch = pendingStores.slice(index, index + this.maxConcurrency);
      const batchResults = await Promise.all(
        batch.map(async (store): Promise<DeletionPartResult> => {
          try {
            return deletionPartResultSchema.parse(
              await store.deleteSubjectData(request),
            );
          } catch {
            return {
              status: "failed",
              storeId: store.id,
              errorCode: "STORE_UNAVAILABLE",
              retryable: true,
            };
          }
        }),
      );
      for (const part of batchResults) {
        partByStoreId.set(part.storeId, part);
        await progress.onPart?.(part);
      }
    }

    const parts = stores.flatMap((store) => {
      const part = partByStoreId.get(store.id);
      return part ? [part] : [];
    });
    const timestamp = this.now().toISOString();
    return deletionReceiptSchema.parse({
      schemaVersion: DATA_INVENTORY_SCHEMA_VERSION,
      receiptId: `${request.workflowId}_receipt`,
      workflowId: request.workflowId,
      status: parts.some((part) => part.status === "failed")
        ? "incomplete"
        : "completed",
      parts,
      verification: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }
}
