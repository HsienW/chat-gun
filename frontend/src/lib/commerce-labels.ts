import type {
  DedupReason,
  OperationStateValue,
  OrderOperationKind,
  OrderOperationState,
} from './commerce-cards';
import type { StreamErrorKind } from './stream-activity-state';

export interface OperationStateDisplay {
  label: string;
  description: string;
  tone: 'pending' | 'progress' | 'success' | 'neutral' | 'warning' | 'danger';
}

/** Display mapping only: the state always comes from the backend card (design §8.2). */
const OPERATION_STATE_DISPLAY: Record<OrderOperationState, OperationStateDisplay> = {
  requested: { label: '已提出申請', description: '申請已建立，尚未進入審批。', tone: 'pending' },
  awaiting_approval: {
    label: '等待審批',
    description: '請選擇核准、拒絕或取消申請。',
    tone: 'pending',
  },
  approved: { label: '已核准', description: '審批已核准，等待訂單系統執行。', tone: 'progress' },
  executing: { label: '執行中', description: '訂單系統處理中。', tone: 'progress' },
  confirmed: { label: '已確認', description: '訂單系統已完成此操作。', tone: 'success' },
  deduplicated: {
    label: '重複申請',
    description: '與既有申請相同，未重複執行。',
    tone: 'neutral',
  },
  failed: { label: '未完成', description: '操作沒有完成，訂單未被變更。', tone: 'danger' },
  approval_denied: { label: '審批已拒絕', description: '審批被拒絕，不會執行。', tone: 'neutral' },
  approval_expired: { label: '審批逾期', description: '超過審批期限，不會執行。', tone: 'neutral' },
  cancelled_before_effect: {
    label: '已在生效前取消',
    description: '申請已在生效前取消，不會執行。',
    tone: 'neutral',
  },
  outcome_unknown: {
    label: '結果待確認',
    description: '結果待確認，已建立核對工作，請勿重複申請。',
    tone: 'warning',
  },
};

const UNKNOWN_STATE_DISPLAY: OperationStateDisplay = {
  label: '狀態未知',
  description: '無法辨識目前的狀態，請稍後再查詢。',
  tone: 'neutral',
};

export function getOperationStateDisplay(state: OperationStateValue): OperationStateDisplay {
  return state.known ? OPERATION_STATE_DISPLAY[state.value] : UNKNOWN_STATE_DISPLAY;
}

export const OPERATION_KIND_LABELS: Record<OrderOperationKind, string> = {
  refund_request: '退款申請',
  cancel: '取消訂單',
};

export const DEDUP_REASON_LABELS: Record<DedupReason, string> = {
  committed_result_reused: '原申請已完成',
  in_flight_duplicate: '原申請仍在處理',
  original_outcome_unknown: '原申請結果待確認',
};

export const COMMERCE_LABELS = {
  mockNotice: '模擬訂單操作（mock）',
  order: '訂單',
  deadline: '審批期限',
  deadlinePassed: '已超過審批期限，系統確認中',
  approve: '核准',
  deny: '拒絕',
  cancelRequest: '取消申請',
  originalOperation: '原操作',
  originalOperationUnavailable: '原操作狀態無法取得',
  reconciliationTask: '核對工作',
  reasonCode: '原因代碼',
  externalOperation: '訂單系統編號',
  unsupportedCards: (count: number) => `有 ${count} 張卡片無法顯示。`,
  errorCode: '錯誤代碼',
};

export type ConfirmationSubmitError = { kind: StreamErrorKind; code?: string };

export type ConfirmationSubmission =
  | { approvalId: string; status: 'submitting' }
  | { approvalId: string; status: 'failed'; error: ConfirmationSubmitError };

const SUBMIT_ERROR_MESSAGES: Record<StreamErrorKind, string> = {
  timeout: '送出逾時，決定尚未生效，請重新選擇。',
  abort: '送出已中斷，決定尚未生效，請重新選擇。',
  generic: '送出失敗，決定尚未生效，請重新選擇。',
};

export function getSubmitErrorMessage(error: ConfirmationSubmitError): string {
  return SUBMIT_ERROR_MESSAGES[error.kind];
}
