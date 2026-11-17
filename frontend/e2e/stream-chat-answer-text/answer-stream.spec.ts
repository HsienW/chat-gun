import { FRONTEND_ERROR_MESSAGES } from '../../src/lib/error-messages';
import { ai, envelope } from '../support/contract';
import type { RunContext } from '../support/fixture-server';
import { cancelButton, expect, expectIdle, expectStreaming, openEntry, sendMessage, test } from '../support/test';

// stream-chat-answer-text Task 7.1 / 7.2: the browser consumes versioned answer_text model.stream
// custom events exactly as the backend emits them (design D4–D6, D11, D12). The fixture plays the
// LangGraph run; the backend emission path itself is covered by backend tests and the cross-layer run.

const COPY = FRONTEND_ERROR_MESSAGES.answerStream;

/** One answer fragment, shaped like the backend `model.stream` envelope (its own sequence space). */
function answer(run: RunContext, sequence: number, textOffset: number, delta: string, messageId = 'msg-1') {
  run.send(
    'custom',
    envelope({
      runId: run.runId,
      sequence,
      type: 'model.stream',
      eventId: `${run.runId}:answer:${sequence}`,
      payload: { delta, messageId, outputKind: 'answer_text', textOffset },
    })
  );
}

/** A run error as Agent Server serializes it: `{ error: name, message: <ErrorEnvelope JSON> }`. */
function answerRunError(run: RunContext, code: string, causeCode?: string) {
  run.error({
    error: 'AnswerStreamRunError',
    message: JSON.stringify({
      error: { source: 'backend', stage: 'chat_response', code, message: code, ...(causeCode ? { cause: { code: causeCode } } : {}) },
    }),
  });
}

test.describe('answer text streaming', () => {
  test('shows the first fragment while the second is held, appends to the same bubble and settles to one answer', async ({
    page,
    server,
  }) => {
    server.onRun(async (run) => {
      run.values({ messages: [...run.inputMessages] });
      answer(run, 1, 0, '第一段答案');
      await run.gate('second');
      answer(run, 2, 5, '，第二段答案');
      await run.gate('final');
      run.values({ messages: [...run.inputMessages, ai('第一段答案，第二段答案', 'msg-1')] });
    });
    await openEntry(page, server, 'Gun Chat');
    await sendMessage(page, '請回答');

    await server.gateReached('second');
    const firstSegment = page.getByText('第一段答案');
    await expect(firstSegment).toBeVisible();
    await expect(page.getByText('第二段答案')).toHaveCount(0);
    // Cancel is available while the answer is streaming.
    await expectStreaming(page);
    await expect(cancelButton(page)).toBeEnabled();
    const bubble = await firstSegment.elementHandle();
    expect(bubble).not.toBeNull();

    server.release('second');
    await expect(page.getByText('第一段答案，第二段答案')).toBeVisible();
    // The same element grew: the draft was appended in place, not re-mounted elsewhere.
    expect(await bubble!.evaluate((node) => [node.isConnected, node.textContent])).toEqual([true, '第一段答案，第二段答案']);

    server.release('final');
    await expectIdle(page);
    await expect(page.getByText('第一段答案，第二段答案')).toHaveCount(1);
    await expect(page.getByText('請回答')).toHaveCount(1);
    // The authoritative thread holds exactly one answer with the streamed message id.
    const thread = server.thread('thread-1');
    expect(thread?.messages.filter((message) => message.type === 'ai').map((message) => message.id)).toEqual(['msg-1']);
  });

  test('keeps the answer intact when a non-text event from another channel arrives between fragments', async ({
    page,
    server,
  }) => {
    server.onRun(async (run) => {
      run.values({ messages: [...run.inputMessages] });
      answer(run, 1, 0, 'Alpha');
      // Another emitter's event of the same run, with its own sequence 1.
      run.update({
        agent: {
          runtimeEvents: [
            envelope({ runId: run.runId, sequence: 1, type: 'model.stream', payload: { delta: 'activity only' } }),
          ],
        },
      });
      answer(run, 2, 5, ' Beta');
      await run.gate('final');
      run.values({ messages: [...run.inputMessages, ai('Alpha Beta', 'msg-1')] });
    });
    await openEntry(page, server, 'Gun Chat');
    await sendMessage(page, 'go');

    await server.gateReached('final');
    await expect(page.getByText('Alpha Beta')).toBeVisible();
    await expect(page.getByText('activity only')).toHaveCount(0);
    server.release('final');
    await expectIdle(page);
    await expect(page.getByText('Alpha Beta')).toHaveCount(1);
  });

  test('demo profile: a dropped connection keeps the fragments, marks them and offers only regeneration', async ({
    page,
    server,
  }) => {
    server.applicationProfile = 'demo';
    server.onRun(
      async (run) => {
        run.values({ messages: [...run.inputMessages] });
        answer(run, 1, 0, '斷線前的內容');
        await run.gate('drop');
        run.disconnect();
      },
      (run) => {
        run.values({ messages: [...run.inputMessages, ai('重新生成的答案', 'msg-2')] });
      }
    );
    await openEntry(page, server, 'Gun Chat');
    await sendMessage(page, '會斷線的問題');

    await server.gateReached('drop');
    await expect(page.getByText('斷線前的內容')).toBeVisible();
    server.release('drop');

    await expect(page.getByRole('status').filter({ hasText: COPY.interrupted })).toBeVisible();
    await expect(page.getByText('斷線前的內容')).toBeVisible();
    const regenerate = page.getByRole('button', { name: COPY.regenerate });
    await expect(regenerate).toBeEnabled();

    await regenerate.click();
    await expect(page.getByText('重新生成的答案')).toBeVisible();
    await expectIdle(page);
    const runs = server.runRequests();
    expect(runs).toHaveLength(2);
    expect(runs[1]?.body?.input?.messages).toEqual([expect.objectContaining({ type: 'human', content: '會斷線的問題' })]);
  });

  test('refusal mid-stream retracts the fragments, shows the refusal and leaves no fragment in history', async ({
    page,
    server,
  }) => {
    server.onRun(async (run) => {
      run.values({ messages: [...run.inputMessages] });
      answer(run, 1, 0, '即將被拒答的片段');
      await run.gate('refuse');
      answerRunError(run, 'answer_stream_refused');
    });
    await openEntry(page, server, 'Gun Chat');
    await sendMessage(page, '敏感問題');

    await server.gateReached('refuse');
    await expect(page.getByText('即將被拒答的片段')).toBeVisible();
    server.release('refuse');

    await expect(page.getByText(COPY.refused)).toHaveCount(1);
    await expect(page.getByText('即將被拒答的片段')).toHaveCount(0);
    await expect(page.getByRole('button', { name: COPY.regenerate })).toHaveCount(0);
    await expectIdle(page);
    // The refused fragments never became thread state, so reloading the thread cannot show them.
    const thread = server.thread('thread-1');
    expect(thread?.messages.some((message) => message.type === 'ai')).toBe(false);
  });

  test('an agent with the activity timeline shows streamed answer text once, not in the timeline', async ({
    page,
    server,
  }) => {
    server.onRun(async (run) => {
      run.values({ messages: [...run.inputMessages] });
      answer(run, 1, 0, '時間軸代理的答案');
      await run.gate('final');
      run.values({ messages: [...run.inputMessages, ai('時間軸代理的答案', 'msg-1')] });
    });
    await openEntry(page, server, 'Gun Shop');
    await sendMessage(page, '查商品');

    await server.gateReached('final');
    await expect(page.getByText('時間軸代理的答案')).toHaveCount(1);
    server.release('final');
    await expectIdle(page);
    await expect(page.getByText('時間軸代理的答案')).toHaveCount(1);
  });
});
