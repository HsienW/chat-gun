import { FRONTEND_ERROR_MESSAGES } from '../../src/lib/error-messages';
import type { Page } from '@playwright/test';

import { RUNTIME_EVENT_LABELS } from '../../src/lib/runtime-event-config';
import { activeRunUpdate, ai, envelope } from '../support/contract';
import type { FixtureServer, RunContext } from '../support/fixture-server';
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

// stream-agent-answer-text Task 6: both new graph entries use the existing browser pipeline.
const agentEntries = [
  { entry: 'Gun Chat', assistant: 'deep_researcher' },
  { entry: 'Gun Shop', assistant: 'shopping_assistant' },
] as const;

type AnswerAgentEntry = (typeof agentEntries)[number];

async function startAgentAnswer(page: Page, server: FixtureServer, agent: AnswerAgentEntry) {
  await openEntry(page, server, agent.entry);
  if (agent.assistant === 'deep_researcher') {
    const toggle = page.getByRole('switch', { name: '深度研究' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
  }
  const request = page.waitForRequest((candidate) =>
    candidate.method() === 'POST' && new URL(candidate.url()).pathname.endsWith('/runs/stream')
  );
  await sendMessage(page, '請用來源回答我的問題');
  expect((await request).postDataJSON()).toMatchObject({ assistant_id: agent.assistant });
}

async function expectAuthoritativeHistory(page: Page, server: FixtureServer, content: string) {
  await page.reload();
  const response = await page.request.post(server.origin + '/api/langgraph/threads/thread-1/history', { data: { limit: 1 } });
  expect(response.ok()).toBe(true);
  const states: { values: { messages: { type: string; id: string; content: unknown }[] } }[] = await response.json();
  expect(states[0]?.values.messages.filter((message) => message.type === 'ai')).toEqual([ai(content, 'msg-1')]);
}

test.describe('deep research and policy answer text streaming', () => {
  test('deep research streams with its timeline open and replaces the draft with the guarded answer', async ({ page, server }) => {
    const first = '有來源支持的結論。';
    const suffix = '沒有來源的引用 [2]。';
    const final = '有來源支持的結論 [1]。';
    const timeline = page.getByRole('button', { name: RUNTIME_EVENT_LABELS.timelineTitle });
    const timelinePanel = timeline.locator('xpath=ancestor::div[contains(@class, "max-h-96")][1]');
    const toolEvent = page.getByText(RUNTIME_EVENT_LABELS.toolStarted('web_search'), { exact: true });
    server.onRun(async (run) => {
      run.values({ messages: [...run.inputMessages] });
      run.update(activeRunUpdate(run.runId, 1));
      run.update({ search_web: { runtimeEvents: [envelope({
        runId: run.runId, sequence: 1, type: 'tool.start', payload: { toolName: 'web_search' },
      })] } });
      answer(run, 1, 0, first);
      await run.gate('research-second');
      answer(run, 2, first.length, suffix);
      await run.gate('research-final');
      const guarded = ai(final, 'msg-1');
      run.update({ synthesize_answer: { messages: [guarded] } });
      run.values({ messages: [...run.inputMessages, guarded] });
    });
    await startAgentAnswer(page, server, agentEntries[0]);
    await server.gateReached('research-second');
    await expect(timeline).toBeVisible();
    await expect(toolEvent).toBeVisible();
    await expect(page.getByText(first, { exact: true })).toHaveCount(1);
    await expect(timelinePanel).not.toContainText(first);
    await expect(page.getByText(suffix)).toHaveCount(0);
    server.release('research-second');
    await server.gateReached('research-final');
    await expect(page.getByText(first + suffix, { exact: true })).toHaveCount(1);
    await expect(timelinePanel).not.toContainText(first);
    server.release('research-final');
    await expectIdle(page);
    await expect(page.getByText(first + suffix, { exact: true })).toHaveCount(0);
    await expect(page.getByText(final, { exact: true })).toBeVisible();
    // Reopen the archived timeline to detect a second copy hidden by its default collapse.
    if (!(await toolEvent.isVisible())) await timeline.press('Enter');
    await expect(toolEvent).toBeVisible();
    const finalItem = timelinePanel.getByText(RUNTIME_EVENT_LABELS.finalAnswer, { exact: true }).locator('..');
    await expect(finalItem.locator('p').last()).toHaveText(final);
    await expect(timelinePanel.getByText(first, { exact: true })).toHaveCount(0);
    await expect(timelinePanel).not.toContainText(suffix);
    await expect(page.getByText(final, { exact: true }).locator('xpath=self::*[not(ancestor::div[contains(@class, "max-h-96")])]')).toHaveCount(1);
    await expectAuthoritativeHistory(page, server, final);
  });

  test('Gun Shop appends policy text and withdraws an unverified answer in the same bubble', async ({ page, server }) => {
    const first = '商品可退貨';
    const suffix = '，而且免運費。';
    const final = '目前無法提供經驗證的答案。';
    server.onRun(async (run) => {
      run.values({ messages: [...run.inputMessages] });
      answer(run, 1, 0, first);
      await run.gate('policy-second');
      answer(run, 2, first.length, suffix);
      await run.gate('policy-final');
      const unverified = ai(final, 'msg-1');
      run.update({ policy_answer: { messages: [unverified], turnEvidence: { citations: [], answerStatus: 'unverified' }, runtimeEvents: [] } });
      run.values({ messages: [...run.inputMessages, unverified] });
    });
    await startAgentAnswer(page, server, agentEntries[1]);
    await server.gateReached('policy-second');
    const draft = page.getByText(first, { exact: true });
    await expect(draft).toBeVisible();
    const bubbleText = await draft.elementHandle();
    await expect(page.getByText(suffix)).toHaveCount(0);
    server.release('policy-second');
    await server.gateReached('policy-final');
    await expect(page.getByText(first + suffix, { exact: true })).toHaveCount(1);
    server.release('policy-final');
    await expectIdle(page);
    await expect(page.getByText(final, { exact: true })).toHaveCount(1);
    expect(await bubbleText?.evaluate((node) => [node.isConnected, node.textContent])).toEqual([true, final]);
    await expect(page.getByText(first + suffix, { exact: true })).toHaveCount(0);
    await expectAuthoritativeHistory(page, server, final);
  });

  for (const agent of agentEntries) {
    for (const outcome of ['interrupted', 'refused'] as const) {
      test(agent.assistant + ' shows ' + outcome + ' after publishing visible text', async ({ page, server }) => {
        const partial = '上游停止前的正文';
        server.onRun(async (run) => {
          run.values({ messages: [...run.inputMessages] });
          answer(run, 1, 0, partial);
          await run.gate('terminate');
          answerRunError(run, 'answer_stream_' + outcome, outcome === 'interrupted' ? 'upstream_unavailable' : undefined);
        });
        await startAgentAnswer(page, server, agent);
        await server.gateReached('terminate');
        await expect(page.getByText(partial, { exact: true })).toBeVisible();
        server.release('terminate');
        await expectIdle(page);
        if (outcome === 'refused') {
          await expect(page.getByText(partial, { exact: true })).toHaveCount(0);
          await expect(page.getByText(COPY.refused, { exact: true })).toHaveCount(1);
        } else {
          await expect(page.getByText(partial, { exact: true })).toHaveCount(1);
          await expect(page.getByRole('status').filter({ hasText: COPY.interrupted })).toBeVisible();
        }
        expect(server.thread('thread-1')?.messages.filter((message) => message.type === 'ai')).toEqual([]);
      });
    }
  }
});
