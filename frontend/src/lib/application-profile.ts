/**
 * Deployment profile reported by the BFF (stream-chat-answer-text design D12, disconnect recovery).
 * The frontend never guesses it: an unreadable or unknown answer is treated as `demo`.
 */

export const APPLICATION_PROFILES = ['demo', 'full'] as const;
export type ApplicationProfile = (typeof APPLICATION_PROFILES)[number];

export type AnswerStreamRecovery = 'regenerate_only' | 'thread_resync';

/**
 * Single source for recovery per profile. Both profiles cancel the Run on disconnect today
 * (SDK default `on_disconnect: "cancel"`), so both only offer a user-triggered regeneration.
 */
export const ANSWER_STREAM_RECOVERY: Readonly<Record<ApplicationProfile, AnswerStreamRecovery>> = {
  demo: 'regenerate_only',
  full: 'regenerate_only',
};

export const FALLBACK_APPLICATION_PROFILE: ApplicationProfile = 'demo';

export function parseApplicationProfile(value: unknown): ApplicationProfile {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return FALLBACK_APPLICATION_PROFILE;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== '1') return FALLBACK_APPLICATION_PROFILE;
  const profile = record.profile;
  return APPLICATION_PROFILES.find((candidate) => candidate === profile) ?? FALLBACK_APPLICATION_PROFILE;
}

export async function fetchApplicationProfile(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<ApplicationProfile> {
  try {
    const response = await fetchImpl('/api/application-profile', {
      method: 'GET',
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return FALLBACK_APPLICATION_PROFILE;
    return parseApplicationProfile(await response.json());
  } catch {
    return FALLBACK_APPLICATION_PROFILE;
  }
}
