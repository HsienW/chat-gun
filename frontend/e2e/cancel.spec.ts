import { activeRunUpdate, ai } from './support/contract';
import {
  cancelButton,
  expect,
  expectIdle,
  expectStreaming,
  openEntry,
  sendMessage,
  test,
} from './support/test';
import type { FixtureServer, RunContext } from './support/fixture-server';

/** Not in a label module: App.tsx owns the local cancelled message text. */
const CANCELLED_TEXT = '已取消本次回覆。';

/** A run that streams a first part, then parks until the test releases `late`. */
function streamingRun(server: FixtureServer, lateContent: (run: RunContext) => void) {
  server.onRun(async (run) => {
    run.update(activeRunUpdate(run.runId, 1));
    run.values({ messages: [...run.inputMessages, ai('Partial reply', 'ai-cancelled')] });
    await run.gate('late');
    lateContent(run);
  });
}

test.describe('user cancel', () => {
  test('the UI shows cancelled at once without waiting for upstream', async ({ page, server }) => {
    streamingRun(server, (run) => {
      run.values({ messages: [...run.inputMessages, ai('Partial reply that kept going', 'ai-cancelled')] });
    });
    // The cancel run is held open so nothing upstream can drive the UI.
    server.onRun(async (run) => {
      await run.gate('cancel-ack');
    });
    await openEntry(page, server, 'Gun Chat');
    await sendMessage(page, 'long question');
    await expect(page.getByText('Partial reply')).toBeVisible();
    await expectStreaming(page);

    await cancelButton(page).click();

    await expect(page.getByText(CANCELLED_TEXT)).toBeVisible();
    await expect(page.locator('.animate-bounce')).toHaveCount(0);
    expect(server.runRequests()[1]?.ended ?? false).toBe(false);

    server.release('late');
    server.release('cancel-ack');
  });

  test('closes the stream and sends one cancel for the cancelled run', async ({ page, server }) => {
    streamingRun(server, (run) => {
      run.values({ messages: [...run.inputMessages, ai('late', 'ai-cancelled')] });
    });
    server.onRun(() => {});
    await openEntry(page, server, 'Gun Chat');
    await sendMessage(page, 'long question');
    await server.gateReached('late');
    await expect(page.getByText('Partial reply')).toBeVisible();

    await cancelButton(page).click();

    await expect.poll(() => server.runRequests().length).toBe(2);
    const [original, cancel] = server.runRequests();
    await expect.poll(() => original?.closedBeforeEnd).toBe(true);
    expect(cancel?.body?.kind).toBe('cancel');
    expect(cancel?.body?.targetRunId).toBe(original?.runId);
    expect(cancel?.body?.inputKind).toBe('cancel');
    expect(cancel?.headers.activeRunId).toBe(original?.runId);
    server.release('late');
    await expectIdle(page);
    expect(server.runRequests().filter((request) => request.body?.kind === 'cancel')).toHaveLength(1);
  });

  test('late content on the closed stream does not revive the reply', async ({ page, server }) => {
    streamingRun(server, (run) => {
      run.values({ messages: [...run.inputMessages, ai('Partial reply plus late tokens', 'ai-cancelled')] });
      run.send('end', null);
    });
    server.onRun(() => {});
    await openEntry(page, server, 'Gun Chat');
    await sendMessage(page, 'long question');
    await server.gateReached('late');
    await cancelButton(page).click();
    await expect(page.getByText(CANCELLED_TEXT)).toBeVisible();
    const original = server.runRequests()[0];
    await expect.poll(() => original?.closedBeforeEnd).toBe(true);

    server.release('late');

    await expect.poll(() => original?.lateWriteAttempts).toBeGreaterThan(0);
    await expectIdle(page);
    await expect(page.getByText('late tokens')).toHaveCount(0);
    await expect(page.getByText(CANCELLED_TEXT)).toBeVisible();
  });

  test('content of the cancelled run inside the cancel stream does not revive it', async ({ page, server }) => {
    test.fail();
    test.info().annotations.push({ type: 'known-limitation', description: 'KL-3：取消請求串流中屬於已取消 Run 的訊息內容仍會顯示。' });
    streamingRun(server, () => {});
    server.onRun(async (run) => {
      // Upstream still streams the cancelled run's progress, a token chunk of its
      // message and an end frame on the cancel request. Thread state is untouched (Q1).
      run.update(activeRunUpdate('run-1', 1));
      run.send('messages', [
        { type: 'AIMessageChunk', id: 'ai-cancelled', content: ' plus late tokens' },
        { run_id: 'run-1', langgraph_node: 'agent' },
      ]);
      await run.gate('cancel-late');
      run.send('end', null);
    });
    await openEntry(page, server, 'Gun Chat');
    await sendMessage(page, 'long question');
    await server.gateReached('late');
    await cancelButton(page).click();
    await expect(page.getByText(CANCELLED_TEXT)).toBeVisible();
    await server.gateReached('cancel-late');

    await expect(page.getByText('late tokens')).toHaveCount(0);
    await expect(page.getByText(CANCELLED_TEXT)).toBeVisible();

    server.release('late');
    server.release('cancel-late');
    await expectIdle(page);
    await expect(page.getByText('late tokens')).toHaveCount(0);
    await expect(page.getByText(CANCELLED_TEXT)).toBeVisible();
  });

  test('a new reply after cancel streams normally and leaves the cancelled one unchanged', async ({ page, server }) => {
    streamingRun(server, () => {});
    server.onRun(() => {});
    server.onRun(async (run) => {
      run.values({ messages: [...run.inputMessages, ai('Fresh', 'ai-new')] });
      await run.gate('fresh-rest');
      run.values({ messages: [...run.inputMessages, ai('Fresh answer complete.', 'ai-new')] });
    });
    await openEntry(page, server, 'Gun Chat');
    await sendMessage(page, 'long question');
    await server.gateReached('late');
    await cancelButton(page).click();
    await expect(page.getByText(CANCELLED_TEXT)).toBeVisible();
    await expectIdle(page);
    server.release('late');

    await sendMessage(page, 'new question');

    await server.gateReached('fresh-rest');
    await expect(page.getByText('Fresh')).toBeVisible();
    await expectStreaming(page);
    server.release('fresh-rest');
    await expect(page.getByText('Fresh answer complete.')).toBeVisible();
    await expectIdle(page);
    const prompts = server.runRequests().filter((request) => request.body?.kind === 'prompt');
    expect(prompts).toHaveLength(2);
  });
});
