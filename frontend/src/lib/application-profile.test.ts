import { describe, expect, it, vi } from 'vitest';

import {
  ANSWER_STREAM_RECOVERY,
  APPLICATION_PROFILES,
  fetchApplicationProfile,
  parseApplicationProfile,
} from '@/lib/application-profile';

describe('parseApplicationProfile', () => {
  it('reads the closed profile set', () => {
    expect(parseApplicationProfile({ schemaVersion: '1', profile: 'demo' })).toBe('demo');
    expect(parseApplicationProfile({ schemaVersion: '1', profile: 'full', future: true })).toBe('full');
  });

  it.each([
    [{ schemaVersion: '1', profile: 'staging' }],
    [{ schemaVersion: '2', profile: 'full' }],
    [{ profile: 'full' }],
    [null],
    ['full'],
    [['full']],
  ])('fails closed to demo for %j', (value) => {
    expect(parseApplicationProfile(value)).toBe('demo');
  });
});

describe('fetchApplicationProfile', () => {
  it('reads the BFF profile endpoint', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ schemaVersion: '1', profile: 'full' }));
    await expect(fetchApplicationProfile(fetchImpl)).resolves.toBe('full');
    expect(fetchImpl).toHaveBeenCalledWith('/api/application-profile', expect.objectContaining({ method: 'GET' }));
  });

  it('fails closed to demo on an error status or a network failure', async () => {
    await expect(fetchApplicationProfile(vi.fn(async () => new Response('no', { status: 503 })))).resolves.toBe('demo');
    await expect(
      fetchApplicationProfile(vi.fn(async () => {
        throw new TypeError('network down');
      }))
    ).resolves.toBe('demo');
  });
});

describe('ANSWER_STREAM_RECOVERY', () => {
  it('maps every profile; both regenerate only while runs cancel on disconnect', () => {
    expect(Object.keys(ANSWER_STREAM_RECOVERY).sort()).toEqual([...APPLICATION_PROFILES].sort());
    expect(ANSWER_STREAM_RECOVERY).toEqual({ demo: 'regenerate_only', full: 'regenerate_only' });
  });
});
