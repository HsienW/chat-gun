import { describe, expect, it, vi } from 'vitest';
import fixture from '../../../contracts/execution-context.fixture.json';

import {
  createInteractionMetadataFetch,
  createInteractionRequestMetadata,
  withInteractionRequestMetadata,
} from '@/lib/interaction-request-metadata';

describe('interaction request metadata', () => {
  it('uses the shared cross-layer ID fixture', () => {
    expect(() => createInteractionRequestMetadata(undefined, () => fixture.malformedRequestId)).toThrow();
    expect(() => createInteractionRequestMetadata(undefined, () => 'x'.repeat(fixture.oversizedIdLength))).toThrow();
  });
  it('rejects malformed generated request IDs before submit', () => {
    expect(() => createInteractionRequestMetadata(undefined, () => 'bad id')).toThrow();
  });

  it('omits a malformed active-run hint and never stores malformed metadata', () => {
    const metadata = createInteractionRequestMetadata(
      { runId: '../../invalid', generation: 1 },
      () => '11111111-1111-4111-8111-111111111111'
    );
    expect(metadata.activeRunHint).toBeUndefined();
    const options = { config: { configurable: { existing: true } } };
    expect(withInteractionRequestMetadata(options, {
      requestId: 'bad id',
      idempotencyKey: '22222222-2222-4222-8222-222222222222',
    })).toBe(options);
  });

  it('creates request-scoped UUID metadata and carries a prior active-run hint', () => {
    const values = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ];
    const metadata = createInteractionRequestMetadata(
      { runId: 'run-1', generation: 7 },
      () => values.shift() ?? ''
    );

    expect(metadata).toEqual({
      requestId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey: '22222222-2222-4222-8222-222222222222',
      activeRunHint: { runId: 'run-1', generation: 7 },
    });
  });

  it('stores metadata in per-submit configurable state without replacing existing config', () => {
    const metadata = createInteractionRequestMetadata(
      undefined,
      () => '11111111-1111-4111-8111-111111111111'
    );

    expect(
      withInteractionRequestMetadata(
        { config: { configurable: { existing: 'kept' } }, command: { resume: true } },
        metadata
      )
    ).toEqual({
      command: { resume: true },
      config: {
        configurable: {
          existing: 'kept',
          clientInteractionMetadata: metadata,
        },
      },
    });
  });

  it('originates validated headers from the metadata bound to that request body', async () => {
    const baseFetch = vi.fn<typeof fetch>(async () =>
      new Response(null, { status: 204 })
    );
    const metadataFetch = createInteractionMetadataFetch(baseFetch);
    const body = JSON.stringify({
      config: {
        configurable: {
          clientInteractionMetadata: {
            requestId: '11111111-1111-4111-8111-111111111111',
            idempotencyKey: '22222222-2222-4222-8222-222222222222',
            activeRunHint: { runId: 'run-7', generation: 7 },
          },
        },
      },
    });

    await metadataFetch('http://localhost/api/langgraph/runs/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

    const init = baseFetch.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get('x-request-id')).toBe(
      '11111111-1111-4111-8111-111111111111'
    );
    expect(headers.get('x-idempotency-key')).toBe(
      '22222222-2222-4222-8222-222222222222'
    );
    expect(headers.get('x-active-run-id')).toBe('run-7');
    expect(headers.get('x-active-run-generation')).toBe('7');
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('does not originate interaction headers from malformed body metadata', async () => {
    const baseFetch = vi.fn<typeof fetch>(async () =>
      new Response(null, { status: 204 })
    );
    const metadataFetch = createInteractionMetadataFetch(baseFetch);

    await metadataFetch('http://localhost/api/langgraph/runs/stream', {
      method: 'POST',
      headers: { 'x-request-id': 'bad id', 'x-idempotency-key': 'bad id' },
      body: JSON.stringify({
        config: {
          configurable: {
            clientInteractionMetadata: {
              requestId: 'not-a-uuid',
              idempotencyKey: 'also-invalid',
              activeRunHint: { runId: '', generation: 0 },
            },
          },
        },
      }),
    });

    const headers = new Headers(baseFetch.mock.calls[0]?.[1]?.headers);
    expect(headers.has('x-request-id')).toBe(false);
    expect(headers.has('x-idempotency-key')).toBe(false);
    expect(headers.has('x-active-run-id')).toBe(false);
  });
});
