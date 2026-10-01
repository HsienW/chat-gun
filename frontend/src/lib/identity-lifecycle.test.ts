import { describe, expect, it, vi } from 'vitest';

import {
  classifyIdentityFailure,
  migrateAnonymousIdentity,
  parseIdentityFailure,
} from './identity-lifecycle';

describe('identity failure contract', () => {
  it.each([
    ['IDENTITY_SESSION_EXPIRED', 'reauth'],
    ['IDENTITY_REVOKED_CREDENTIAL', 'reauth'],
    ['IDENTITY_ACCOUNT_SUSPENDED', 'safe_degrade'],
    ['IDENTITY_DELETION_PENDING', 'safe_degrade'],
  ] as const)('uses typed %s instead of display text', (code, action) => {
    const parsed = parseIdentityFailure(JSON.stringify({
      error: { code, message: '任意顯示文字' },
    }));
    expect(parsed).toEqual({ code, message: '任意顯示文字' });
    expect(classifyIdentityFailure(parsed)).toBe(action);
  });

  it('does not infer identity state from display text', () => {
    expect(parseIdentityFailure({ error: 'session expired' })).toBeUndefined();
  });
});

describe('anonymous migration client', () => {
  it('sends the versioned contract with idempotency header', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      schemaVersion: '1.0.0',
      result: 'migrated',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const request = {
      schemaVersion: '1.0.0' as const,
      anonymousId: 'anonymous_01',
      anonymousSessionId: 'session_01',
      anonymousDeviceId: 'device_01',
      anonymousCredential: 'secret',
      idempotencyKey: 'migration_01',
    };
    await expect(migrateAnonymousIdentity(request, fetchImpl)).resolves.toEqual({
      schemaVersion: '1.0.0',
      result: 'migrated',
    });
    expect(fetchImpl).toHaveBeenCalledWith('/api/identity/anonymous-migrate', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'x-idempotency-key': 'migration_01' }),
      body: JSON.stringify(request),
    }));
  });
});
