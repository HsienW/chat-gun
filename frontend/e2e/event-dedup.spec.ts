import { RUNTIME_EVENT_LABELS } from '../src/lib/runtime-event-config';
import { activeRunUpdate, ai, envelope } from './support/contract';
import {
  expect,
  expectIdle,
  messageInput,
  openEntry,
  sendMessage,
  submitButton,
  test,
} from './support/test';
import type { FixtureServer, RunContext } from './support/fixture-server';
import type { Page } from '@playwright/test';

/** Versioned events only reach the timeline on Gun Shop (design §1). */
function eventsRun(events: (run: RunContext) => Record<string, unknown>[]) {
  return async (run: RunContext) => {
    run.values({ messages: [...run.inputMessages] });
    run.update(activeRunUpdate(run.runId, 1));
    for (const event of events(run)) {
      run.update({ agent: { runtimeEvents: [event] } });
    }
    await run.gate('inspect');
    run.values({ messages: [...run.inputMessages, ai('完成。', 'ai-1')] });
  };
}

function toolStart(runId: string, sequence: number, toolName: string, eventId?: string) {
  return envelope({ runId, sequence, eventId, type: 'tool.start', payload: { toolName } });
}

async function start(page: Page, server: FixtureServer) {
  await openEntry(page, server, 'Gun Shop');
  await sendMessage(page, '查訂單');
  await server.gateReached('inspect');
}

/** Ends the held run; the archived timeline collapses, so open it again to read it. */
async function finishAndOpenTimeline(page: Page, server: FixtureServer) {
  server.release('inspect');
  await expectIdle(page);
  // The header button has no clickable box (the card header takes the pointer),
  // so it is opened from the keyboard, which a user can do as well.
  await page.getByRole('button', { name: RUNTIME_EVENT_LABELS.timelineTitle }).press('Enter');
}

test.describe('event and submit dedup', () => {
  test('a repeated eventId changes the timeline once', async ({ page, server }) => {
    server.onRun(
      eventsRun((run) => [
        toolStart(run.runId, 1, 'lookup_order'),
        toolStart(run.runId, 1, 'lookup_order'),
      ])
    );
    await start(page, server);

    await expect(page.getByText(RUNTIME_EVENT_LABELS.toolStarted('lookup_order'))).toHaveCount(1);
    await finishAndOpenTimeline(page, server);
    await expect(page.getByText(RUNTIME_EVENT_LABELS.toolStarted('lookup_order'))).toHaveCount(1);
  });

  test('events out of sequence inside the window render in order', async ({ page, server }) => {
    server.onRun(
      eventsRun((run) => [
        toolStart(run.runId, 2, 'second_tool'),
        toolStart(run.runId, 1, 'first_tool'),
      ])
    );
    await start(page, server);

    const titles = page.getByText(/^工具啟動：/);
    await expect(titles).toHaveText([
      RUNTIME_EVENT_LABELS.toolStarted('first_tool'),
      RUNTIME_EVENT_LABELS.toolStarted('second_tool'),
    ]);
    server.release('inspect');
    await expectIdle(page);
  });

  test('events of a non-authoritative run do not change the screen', async ({ page, server }) => {
    server.onRun(
      eventsRun((run) => [
        toolStart('run-stale', 1, 'stale_tool'),
        toolStart(run.runId, 1, 'fresh_tool'),
      ])
    );
    await start(page, server);

    await expect(page.getByText(RUNTIME_EVENT_LABELS.toolStarted('fresh_tool'))).toBeVisible();
    await expect(page.getByText(RUNTIME_EVENT_LABELS.toolStarted('stale_tool'))).toHaveCount(0);
    await finishAndOpenTimeline(page, server);
    await expect(page.getByText(RUNTIME_EVENT_LABELS.toolStarted('fresh_tool'))).toBeVisible();
    await expect(page.getByText(RUNTIME_EVENT_LABELS.toolStarted('stale_tool'))).toHaveCount(0);
  });

  test('a message id delivered several times is shown once', async ({ page, server }) => {
    server.onRun(async (run) => {
      const messages = [...run.inputMessages, ai('Only once.', 'ai-dup')];
      run.values({ messages });
      run.values({ messages });
      await run.gate('inspect');
      run.values({ messages });
    });
    await start(page, server);

    await expect(page.getByText('Only once.')).toHaveCount(1);
    server.release('inspect');
    await expectIdle(page);
    await expect(page.getByText('Only once.')).toHaveCount(1);
  });

  test('a terminal run stays terminal when terminal or earlier progress events replay', async ({ page, server }) => {
    server.onRun(
      eventsRun((run) => {
        const running = envelope({ runId: run.runId, sequence: 1, type: 'run.status', payload: { status: 'running' } });
        const terminal = envelope({
          runId: run.runId,
          sequence: 3,
          type: 'run.terminal',
          payload: { status: 'completed', reasonCode: 'completed' },
        });
        return [
          running,
          toolStart(run.runId, 2, 'lookup_order'),
          terminal,
          terminal,
          running,
          envelope({
            runId: run.runId,
            sequence: 2,
            eventId: `${run.runId}:late-progress`,
            type: 'run.status',
            payload: { status: 'running' },
          }),
        ];
      })
    );
    await start(page, server);

    const runningTitle = page.getByText(RUNTIME_EVENT_LABELS.runStatus('running'));
    const terminalTitle = page.getByText(RUNTIME_EVENT_LABELS.runTerminal('completed'));
    await expect(terminalTitle).toHaveCount(1);
    await expect(runningTitle).toHaveCount(1);
    await finishAndOpenTimeline(page, server);
    await expect(terminalTitle).toHaveCount(1);
    await expect(runningTitle).toHaveCount(1);
  });

  test('Enter and the send button together submit once', async ({ page, server }) => {
    server.onRun(async (run) => {
      run.values({ messages: [...run.inputMessages] });
      await run.gate('inspect');
      run.values({ messages: [...run.inputMessages, ai('只回一次。', 'ai-1')] });
    });
    await openEntry(page, server, 'Gun Chat');
    await messageInput(page).fill('只送一次');
    await expect(submitButton(page)).toBeEnabled();

    // Both triggers land in one task, before React re-renders the input.
    await page.evaluate(() => {
      const form = document.querySelector('form');
      const textarea = form?.querySelector('textarea');
      const send = form?.querySelector<HTMLButtonElement>('[data-testid="chat-submit"]');
      textarea?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      send?.click();
    });

    await server.gateReached('inspect');
    await expect(page.getByText('只送一次')).toHaveCount(1);
    server.release('inspect');
    await expect(page.getByText('只回一次。')).toBeVisible();
    await expectIdle(page);
    expect(server.runRequests()).toHaveLength(1);
    await expect(page.getByText('只送一次')).toHaveCount(1);
  });
});
