import { test as base, expect, type Locator, type Page } from '@playwright/test';

import { startFixtureServer, type FixtureServer } from './fixture-server';

export { expect };

interface E2EFixtures {
  server: FixtureServer;
  /** Page errors seen during the test; any of them fails the test at teardown. */
  pageErrors: string[];
}

/**
 * One fixture server per test (design D1). Teardown fails the test on an
 * unexpected request, a connection outside the test origin, an uncaught page
 * error, or a scripted run that was never requested (design D5).
 */
export const test = base.extend<E2EFixtures>({
  // Playwright requires the object pattern even when no fixture is used.
  // eslint-disable-next-line no-empty-pattern
  server: async ({}, use) => {
    const server = await startFixtureServer();
    await use(server);
    await server.close();
  },
  // eslint-disable-next-line no-empty-pattern
  pageErrors: async ({}, use) => {
    await use([]);
  },
  page: async ({ page, server, pageErrors }, use) => {
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.context().route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === server.origin) {
        await route.continue();
        return;
      }
      server.recordExternal(url.href);
      await route.abort('blockedbyclient');
    });
    await use(page);
    expect(pageErrors, 'uncaught page errors').toEqual([]);
    expect(server.violations(), 'fixture server violations').toEqual([]);
  },
});

export type EntryName = 'Gun Chat' | 'Gun Shop';

export async function openEntry(page: Page, server: FixtureServer, entry: EntryName): Promise<void> {
  await page.goto(server.appUrl);
  await page.getByRole('button', { name: new RegExp(`^${entry} `) }).click();
}

export function messageInput(page: Page): Locator {
  return page.locator('form').getByRole('textbox');
}

export function submitButton(page: Page): Locator {
  return page.getByTestId('chat-submit');
}

/** Present only while a reply is in flight (the input shows stop instead of send). */
export function cancelButton(page: Page): Locator {
  return page.getByTestId('chat-cancel');
}

export async function sendMessage(page: Page, text: string): Promise<void> {
  await messageInput(page).fill(text);
  await submitButton(page).click();
}

/** Waits until the reply settled: send is back and stop is gone. */
export async function expectIdle(page: Page): Promise<void> {
  await expect(cancelButton(page)).toHaveCount(0);
  await expect(submitButton(page)).toBeVisible();
}

export async function expectStreaming(page: Page): Promise<void> {
  await expect(cancelButton(page)).toBeVisible();
}
