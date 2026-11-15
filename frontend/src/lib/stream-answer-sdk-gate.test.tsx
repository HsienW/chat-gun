import { useStream } from '@langchain/langgraph-sdk/react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentId } from '../types/agents';

afterEach(() => vi.unstubAllGlobals());

describe('stream-chat-answer-text SDK subscription gate', () => {
  for (const assistantId of Object.values(AgentId)) {
    it.each([false, true])(`${assistantId}: custom listener=%s preserves existing modes`, async (custom) => {
      const requests: unknown[] = [];
      const onCustomEvent = vi.fn();
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/threads')) return Response.json({ thread_id: 'gate-thread' });
        if (url.endsWith('/history')) return Response.json([]);
        if (url.endsWith('/runs/stream')) {
          const body: unknown = JSON.parse(String(init?.body));
          requests.push(body);
          return new Response('event: custom\ndata: {"gate":"before-return"}\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        throw new Error(`Unexpected SDK request: ${url}`);
      }));
      const { result, unmount } = renderHook(() => {
        const stream = useStream<{ messages: [] }>({
          apiUrl: 'http://stream-answer-fixture.invalid', assistantId, messagesKey: 'messages',
          onUpdateEvent: () => undefined,
          ...(custom ? { onCustomEvent } : {}),
        });
        // App reads messages and values; the SDK tracks these getters as subscriptions.
        void stream.messages;
        void stream.values;
        return stream;
      });
      try {
        await act(async () => { await result.current.submit({ messages: [] }); });
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ assistant_id: assistantId,
          stream_mode: custom ? ['messages-tuple', 'values', 'updates', 'custom'] : ['messages-tuple', 'values', 'updates'],
        });
        if (custom) expect(onCustomEvent).toHaveBeenCalledWith({ gate: 'before-return' }, expect.any(Object));
      } finally { unmount(); }
    });
  }
});
