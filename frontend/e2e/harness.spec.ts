import { ai, envelope } from './support/contract';
import { expect, expectIdle, expectStreaming, openEntry, sendMessage, test } from './support/test';

test.describe('fixture harness', () => {
  test('an unscripted request is refused and reported as a violation', async ({ page, server }) => {
    await page.goto(server.appUrl);

    const status = await page.evaluate(async () => {
      const response = await fetch('/api/langgraph/assistants/search', { method: 'POST', body: '{}' });
      return response.status;
    });

    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
    expect(server.violations()).toEqual(['unexpected request: POST /api/langgraph/assistants/search']);
    server.clearViolations();
  });

  test('a connection outside the test origin is blocked and reported', async ({ page, server }) => {
    await page.goto(server.appUrl);

    const failed = await page.evaluate(async () => {
      try {
        await fetch('https://example.com/');
        return false;
      } catch {
        return true;
      }
    });

    expect(failed).toBe(true);
    expect(server.violations()).toEqual(['external connection: https://example.com/']);
    server.clearViolations();
  });

  test('a gate holds later content until the test releases it', async ({ page, server }) => {
    server.onRun(async (run) => {
      run.values({ messages: [...run.inputMessages, ai('First part.', 'ai-1')] });
      await run.gate('rest');
      run.values({ messages: [...run.inputMessages, ai('First part. Second part.', 'ai-1')] });
    });
    await openEntry(page, server, 'Gun Chat');
    await sendMessage(page, 'hello');

    await server.gateReached('rest');
    await expect(page.getByText('First part.')).toBeVisible();
    await expectStreaming(page);
    await expect(page.getByText('Second part.')).toHaveCount(0);
    expect(server.runRequests()[0]?.ended).toBe(false);

    server.release('rest');
    await expect(page.getByText('First part. Second part.')).toBeVisible();
    await expectIdle(page);
  });

  test('content that drifts from the frontend contract fails when the scenario is built', () => {
    expect(() =>
      envelope({ runId: 'run-1', sequence: 1, type: 'tool.start', payload: {}, extra: { context: null } })
    ).toThrow(/not a valid envelope/);
    expect(() =>
      envelope({ runId: 'run-1', sequence: 1, type: 'future.kind', payload: {} })
    ).toThrow(/unknown_type/);
    expect(() =>
      envelope({ runId: 'run-1', sequence: 1, type: 'future.kind', payload: {}, expect: 'unknown_type' })
    ).not.toThrow();
  });
});
