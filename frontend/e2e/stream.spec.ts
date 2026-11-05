import { FRONTEND_ERROR_MESSAGES } from '../src/lib/error-messages';
import { RUNTIME_EVENT_LABELS } from '../src/lib/runtime-event-config';
import { activeRunUpdate, ai, bffError, envelope } from './support/contract';
import {
  expect,
  expectIdle,
  expectStreaming,
  messageInput,
  openEntry,
  sendMessage,
  test,
} from './support/test';

const ENVELOPE_LABELS = FRONTEND_ERROR_MESSAGES.errorEnvelope;

test.describe('streamed reply', () => {
  test('renders progressively while streaming and completes once', async ({ page, server }) => {
    server.onRun(async (run) => {
      run.values({ messages: [...run.inputMessages, ai('Tonic Earbuds', 'ai-1')] });
      await run.gate('second');
      run.values({ messages: [...run.inputMessages, ai('Tonic Earbuds last 30 hours.', 'ai-1')] });
      await run.gate('end');
    });
    await openEntry(page, server, 'Gun Chat');
    await sendMessage(page, 'battery life?');

    await server.gateReached('second');
    await expect(page.getByText('Tonic Earbuds')).toBeVisible();
    await expect(page.getByText('last 30 hours.')).toHaveCount(0);
    await expectStreaming(page);

    server.release('second');
    await server.gateReached('end');
    await expect(page.getByText('Tonic Earbuds last 30 hours.')).toBeVisible();
    await expectStreaming(page);

    server.release('end');
    await expectIdle(page);
    await expect(page.getByText('Tonic Earbuds last 30 hours.')).toHaveCount(1);
    await expect(page.getByText('battery life?')).toHaveCount(1);

    // The input accepts the next message once the run settled.
    server.onRun((run) => {
      run.values({ messages: [...run.thread.messages, ...run.inputMessages, ai('Second answer.', 'ai-2')] });
    });
    await sendMessage(page, 'next');
    await expect(page.getByText('Second answer.')).toBeVisible();
    await expectIdle(page);
    expect(server.runRequests()).toHaveLength(2);
  });

  test('degrades unknown events safely and still completes', async ({ page, server }) => {
    server.onRun(async (run) => {
      run.values({ messages: [...run.inputMessages] });
      run.update(activeRunUpdate(run.runId, 1));
      run.update({
        agent: {
          runtimeEvents: [
            envelope({
              runId: run.runId,
              sequence: 1,
              type: 'tool.start',
              payload: { toolName: 'search_catalog', futureField: { nested: [1, 2] } },
              extra: { futureTopLevel: 'kept out of the UI' },
            }),
            envelope({
              runId: run.runId,
              sequence: 2,
              type: 'future.capability',
              payload: { anything: true },
              expect: 'unknown_type',
            }),
          ],
        },
      });
      run.send('future_stream_mode', { unknown: true });
      await run.gate('end');
      run.values({ messages: [...run.inputMessages, ai('Here are the earbuds.', 'ai-1')] });
    });
    await openEntry(page, server, 'Gun Shop');
    await sendMessage(page, 'earbuds');

    await server.gateReached('end');
    await expect(page.getByText(RUNTIME_EVENT_LABELS.unknown('future.capability'))).toBeVisible();
    await expect(page.getByText(RUNTIME_EVENT_LABELS.toolStarted('search_catalog'))).toBeVisible();

    server.release('end');
    await expect(page.getByText('Here are the earbuds.')).toBeVisible();
    await expectIdle(page);
  });

  test('a structured error mid-stream shows a safe failure, never success', async ({ page, server }) => {
    server.onRun(async (run) => {
      run.values({ messages: [...run.inputMessages, ai('Partial answer', 'ai-1')] });
      await run.gate('fail');
      run.error(bffError('upstream_stream_error', 'LangGraph stream ended with an error'));
    });
    await openEntry(page, server, 'Gun Chat');
    await sendMessage(page, 'question');

    await server.gateReached('fail');
    await expect(page.getByText('Partial answer')).toBeVisible();
    server.release('fail');

    await expectIdle(page);
    // The failure is reported as an error envelope, not as a finished answer.
    await expect(page.getByText(new RegExp(`${ENVELOPE_LABELS.code}: \\S+`))).toBeVisible();
    await expect(page.getByText(/at \S+:\d+:\d+|Traceback|\[object Object\]/)).toHaveCount(0);

    // A new message can be sent after the failure.
    server.onRun((run) => {
      run.values({ messages: [...run.thread.messages, ...run.inputMessages, ai('Recovered.', 'ai-2')] });
    });
    await sendMessage(page, 'retry');
    await expect(page.getByText('Recovered.')).toBeVisible();
    await expect(messageInput(page)).toBeEditable();
  });

  for (const code of ['bff_timeout', 'upstream_timeout']) {
    test(`a ${code} error frame shows timeout semantics`, async ({ page, server }) => {
      test.fail();
      test.info().annotations.push({ type: 'known-limitation', description: 'KL-1：逾時錯誤 frame 的結構化錯誤碼未保留，逾時語意遺失。' });
      server.onRun((run) => {
        run.error(bffError(code, 'LangGraph stream timed out'));
      });
      await openEntry(page, server, 'Gun Chat');
      await sendMessage(page, 'slow question');

      await expectIdle(page);
      await expect(page.getByText(`${ENVELOPE_LABELS.code}: ${code}`)).toBeVisible();
      await expect(page.getByText(`${ENVELOPE_LABELS.code}: ${FRONTEND_ERROR_MESSAGES.stream.unknownCode}`)).toHaveCount(0);
    });
  }
});
