// stream-chat-answer-text Task 7.1 cross-layer run (local evidence, not part of `test:e2e`).
// Drives a real browser through the real BFF and backend against mock-provider.mjs, which sends
// the first segment and holds the second until GET /release.
// Usage: node cross-layer-run.mjs <appUrl> <providerUrl> <evidencePath>
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { chromium } from '@playwright/test';

const [appUrl, providerUrl, evidencePath] = process.argv.slice(2);
if (!appUrl || !providerUrl || !evidencePath) throw new Error('usage: cross-layer-run.mjs <appUrl> <providerUrl> <evidencePath>');

const FIRST = 'FIXTURE-FIRST-SEGMENT';
const FULL = 'FIXTURE-FIRST-SEGMENT FIXTURE-SECOND-SEGMENT';
const checks = [];
const check = (name, ok, detail = {}) => checks.push({ name, ok: Boolean(ok), ...detail });
const t0 = performance.now();
const at = () => Math.round(performance.now() - t0);

const browser = await chromium.launch();
const page = await browser.newPage();
const customFrames = [];
page.on('console', (message) => {
  if (message.type() === 'error') checks.push({ name: 'console.error', ok: false, text: message.text().slice(0, 200) });
});
try {
  await page.goto(appUrl);
  await page.getByRole('button', { name: /^Gun Chat / }).click();
  await page.locator('form').getByRole('textbox').fill('跨層串流驗證');
  const sentAt = at();
  await page.getByTestId('chat-submit').click();

  const first = page.getByText(FIRST, { exact: true });
  await first.waitFor({ state: 'visible', timeout: 15_000 });
  const firstVisibleAt = at();
  check('first segment visible while provider holds the second', true, { firstVisibleMs: firstVisibleAt - sentAt });
  check('second segment not shown before release', (await page.getByText('FIXTURE-SECOND-SEGMENT').count()) === 0);
  check('cancel available while streaming', await page.getByTestId('chat-cancel').isVisible());
  const bubble = await first.elementHandle();

  const released = await fetch(new URL('/release', providerUrl));
  check('provider released', released.ok);
  await page.getByText(FULL, { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
  const [connected, text] = await bubble.evaluate((node) => [node.isConnected, node.textContent]);
  check('same bubble appended in place', connected && text === FULL, { text });

  await page.getByTestId('chat-submit').waitFor({ state: 'visible', timeout: 15_000 });
  check('run settled', (await page.getByTestId('chat-cancel').count()) === 0, { settledMs: at() - sentAt });
  check('exactly one answer after completion', (await page.getByText(FULL, { exact: true }).count()) === 1);
  check('no error bubble', (await page.getByText('unknown_error').count()) === 0);
} catch (error) {
  checks.push({ name: 'run', ok: false, error: String(error).slice(0, 300) });
} finally {
  await browser.close();
}

const evidence = { kind: 'cross-layer-answer-stream-run', measuredAt: new Date().toISOString(), appUrl, customFrames: customFrames.length, checks, passed: checks.every((entry) => entry.ok) };
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
process.exitCode = evidence.passed ? 0 : 1;
