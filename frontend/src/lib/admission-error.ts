import { parseErrorEnvelope } from '@/types/errors';

export const ADMISSION_MESSAGES = {
  usage_budget_exhausted: '今日使用額度已用完，請於重置後再試。',
  usage_budget_unavailable: '目前無法確認使用額度，請稍後再試。',
  run_quota_exhausted: '今日研究次數已用完，請於重置後再試。',
  run_concurrency_limited: '目前有較多工作正在進行，請稍後手動重試。',
  feature_disabled: '目前未開放這項功能。',
} as const;
export type AdmissionFailure = { code: string; budgetScope?: string; retryAt?: number };

export function parseAdmissionFailure(value: unknown, now = Date.now()): AdmissionFailure | undefined {
  const candidate = value instanceof Error ? ('text' in value ? value.text : value.message) : value;
  const envelope = parseErrorEnvelope(candidate);
  if (!envelope || (envelope.error.stage !== 'run_admission' && !Object.prototype.hasOwnProperty.call(ADMISSION_MESSAGES, envelope.error.code))) return undefined;
  const { code, details } = envelope.error;
  const retryAfter = details?.retryAfter;
  return { code, ...(typeof details?.budgetScope === 'string' ? { budgetScope: details.budgetScope } : {}),
    ...(typeof retryAfter === 'number' && Number.isSafeInteger(retryAfter) && retryAfter > 0 && Number.isSafeInteger(now + retryAfter * 1000)
      ? { retryAt: now + retryAfter * 1000 } : {}),
  };
}

/** SDK 0.0.74 consumes the body before its hook; capture a clone at the fetch boundary. */
export function createAdmissionTransport(baseFetch: typeof fetch) {
  const failures = new WeakMap<Response, unknown>();
  return {
    fetch: (async (input, init) => {
      const response = await baseFetch(input, init);
      if (!response.ok) {
        try {
          const payload: unknown = await response.clone().json();
          if (parseAdmissionFailure(payload)) failures.set(response, payload);
        } catch { /* Other transport errors keep their existing SDK handling. */ }
      }
      return response;
    }) satisfies typeof fetch,
    onFailedResponseHook: async (response?: Response): Promise<boolean> => {
      const payload = response ? failures.get(response) : undefined;
      if (payload !== undefined) throw new Error(JSON.stringify(payload));
      return false;
    },
  };
}
