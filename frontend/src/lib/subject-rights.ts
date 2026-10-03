export type ReceiptPartStatus = 'completed' | 'skipped' | 'retained_by_policy' | 'failed';

export type SubjectRightWorkflow = {
  schemaVersion: '1.0.0';
  workflowId: string;
  type: 'export' | 'deletion' | 'deletion_verification' | 'consent';
  status: 'requested' | 'in_progress' | 'completed' | 'failed' | 'expired';
  receipt?: {
    status: 'completed' | 'incomplete';
    parts: Array<{
      storeId: string;
      status: ReceiptPartStatus;
      reasonCode?: string;
      retryable?: boolean;
    }>;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const WORKFLOW_TYPES = ['export', 'deletion', 'deletion_verification', 'consent'] as const;
const WORKFLOW_STATUSES = ['requested', 'in_progress', 'completed', 'failed', 'expired'] as const;
const PART_STATUSES = ['completed', 'skipped', 'retained_by_policy', 'failed'] as const;

function isWorkflowType(value: unknown): value is SubjectRightWorkflow['type'] {
  return typeof value === 'string' && WORKFLOW_TYPES.some((type) => type === value);
}

function isWorkflowStatus(value: unknown): value is SubjectRightWorkflow['status'] {
  return typeof value === 'string' && WORKFLOW_STATUSES.some((status) => status === value);
}

function isPartStatus(value: unknown): value is ReceiptPartStatus {
  return typeof value === 'string' && PART_STATUSES.some((status) => status === value);
}

export function parseSubjectRightWorkflow(value: unknown): SubjectRightWorkflow | undefined {
  if (!isRecord(value) || value.schemaVersion !== '1.0.0' ||
      typeof value.workflowId !== 'string' ||
      !isWorkflowType(value.type) ||
      !isWorkflowStatus(value.status)) {
    return undefined;
  }
  let receipt: SubjectRightWorkflow['receipt'];
  if (value.receipt !== undefined) {
    if (!isRecord(value.receipt) ||
        (value.receipt.status !== 'completed' && value.receipt.status !== 'incomplete') ||
        !Array.isArray(value.receipt.parts)) return undefined;
    const parts = value.receipt.parts.flatMap((part) => {
      if (!isRecord(part) || typeof part.storeId !== 'string' ||
          !isPartStatus(part.status)) return [];
      return [{
        storeId: part.storeId,
        status: part.status,
        ...(typeof part.reasonCode === 'string' ? { reasonCode: part.reasonCode } : {}),
        ...(typeof part.retryable === 'boolean' ? { retryable: part.retryable } : {}),
      }];
    });
    if (parts.length !== value.receipt.parts.length) return undefined;
    receipt = { status: value.receipt.status, parts };
  }
  return {
    schemaVersion: '1.0.0',
    workflowId: value.workflowId,
    type: value.type,
    status: value.status,
    ...(receipt ? { receipt } : {}),
  };
}

export async function requestSubjectRight(
  kind: 'export' | 'deletion' | 'consent',
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<SubjectRightWorkflow> {
  const response = await fetchImpl(`/api/subject-rights/${kind}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = parseSubjectRightWorkflow(await response.json().catch(() => undefined));
  if (!response.ok || !parsed) throw new Error('SUBJECT_RIGHT_REQUEST_FAILED');
  return parsed;
}
