import { FRONTEND_ERROR_MESSAGES } from '../src/lib/error-messages';
import { ai, bffError, clarificationInterruptUpdate } from './support/contract';
import { expect, expectIdle, openEntry, sendMessage, test } from './support/test';
import type { FixtureServer } from './support/fixture-server';
import type { Page } from '@playwright/test';

const INTERRUPT_ID = `clarification:${'b'.repeat(64)}`;
const CANDIDATE = {
  name: 'Springfield',
  displayName: 'Springfield, Illinois, United States',
  country: 'United States',
  latitude: 39.78,
  longitude: -89.65,
};

/** Not in a label module: WeatherToolResult owns these control and status texts. */
const SUBMIT = 'Submit';
const CANCEL = 'Cancel';
const NOT_FOUND_LABEL = '找不到地點';

async function openClarification(page: Page, server: FixtureServer): Promise<void> {
  server.onRun((run) => {
    run.values({ messages: [...run.inputMessages] });
    run.update(clarificationInterruptUpdate({ interruptId: INTERRUPT_ID, candidates: [CANDIDATE] }));
  });
  await openEntry(page, server, 'Gun Chat');
  await sendMessage(page, 'Springfield weather now');
  // The tool panel starts collapsed; the user opens it to see the candidates.
  await page.getByRole('button', { name: /current_weather/ }).click();
  await expect(page.getByRole('button', { name: new RegExp(CANDIDATE.displayName) })).toBeVisible();
  await expectIdle(page);
}

test.describe('clarification resume', () => {
  test('choosing a candidate resumes once with that candidate and the interruptId', async ({ page, server }) => {
    await openClarification(page, server);
    server.onRun((run) => {
      run.values({
        messages: [...run.thread.messages, ai('Springfield, Illinois is sunny, 21°C.', 'ai-weather')],
      });
    });

    await page.getByRole('button', { name: new RegExp(CANDIDATE.displayName) }).click();
    await page.getByRole('button', { name: SUBMIT, exact: true }).click();

    await expect(page.getByText('Springfield, Illinois is sunny, 21°C.')).toBeVisible();
    await expectIdle(page);
    await expect(page.getByRole('button', { name: SUBMIT, exact: true })).toHaveCount(0);
    const resumes = server.runRequests().slice(1);
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.body?.resume).toEqual({ userReply: CANDIDATE.displayName, candidateIndex: 1 });
    expect(resumes[0]?.body?.inputKind).toBe('clarification_resume');
    expect(resumes[0]?.body?.interruptId).toBe(INTERRUPT_ID);
  });

  test('cancelling sends one cancel resume and is not shown as not found', async ({ page, server }) => {
    await openClarification(page, server);
    server.onRun((run) => {
      run.values({ messages: [...run.thread.messages, ai('好的，已取消地點查詢。', 'ai-cancel')] });
    });

    await page.getByRole('button', { name: CANCEL, exact: true }).click();

    await expect(page.getByText('好的，已取消地點查詢。')).toBeVisible();
    await expectIdle(page);
    const resumes = server.runRequests().slice(1);
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.body?.resume).toEqual({ cancel: true });
    expect(resumes[0]?.body?.interruptId).toBe(INTERRUPT_ID);
    await expect(page.getByText(NOT_FOUND_LABEL)).toHaveCount(0);
  });

  test('a structured error on resume shows a safe error, not success', async ({ page, server }) => {
    await openClarification(page, server);
    server.onRun((run) => {
      run.error(bffError('upstream_stream_error', 'LangGraph stream ended with an error'));
    });

    await page.getByRole('button', { name: new RegExp(CANDIDATE.displayName) }).click();
    await page.getByRole('button', { name: SUBMIT, exact: true }).click();

    await expectIdle(page);
    await expect(
      page.getByText(new RegExp(`${FRONTEND_ERROR_MESSAGES.errorEnvelope.code}: \\S+`))
    ).toBeVisible();
    await expect(page.getByText(/sunny/)).toHaveCount(0);
    await expect(page.getByText(/at \S+:\d+:\d+|Traceback|\[object Object\]/)).toHaveCount(0);
    expect(server.runRequests().slice(1)).toHaveLength(1);
  });
});
