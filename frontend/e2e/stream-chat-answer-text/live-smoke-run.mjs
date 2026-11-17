// stream-chat-answer-text Task 7.3 live smoke (local evidence, not part of `test:e2e`).
// Sends one long plain-text question through the real BFF and backend to the configured endpoint
// and records when answer text changes in the browser. Evidence holds timings and counts only.
// Usage: node live-smoke-run.mjs <appUrl> <backendUrl> <evidencePath> <firstLimitMs> <idleLimitMs>
import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const [appUrl, backendUrl, evidencePath, firstLimitArg, idleLimitArg] = process.argv.slice(2);
const firstLimitMs = Number(firstLimitArg);
const idleLimitMs = Number(idleLimitArg);
if (!appUrl || !backendUrl || !evidencePath || !firstLimitMs || !idleLimitMs) {
  throw new Error('usage: live-smoke-run.mjs <appUrl> <backendUrl> <evidencePath> <firstLimitMs> <idleLimitMs>');
}

const QUESTION = '請用繁體中文寫一段約 400 字的純文字說明，主題是串流顯示回答的好處。不要使用 Markdown、清單或標題。';
const browser = await chromium.launch();
const page = await browser.newPage();
const result = { checks: [] };
const check = (name, ok, detail = {}) => result.checks.push({ name, ok: Boolean(ok), ...detail });

try {
  await page.goto(appUrl);
  await page.getByRole('button', { name: /^Gun Chat / }).click();
  await page.locator('form').getByRole('textbox').fill(QUESTION);
  // Record answer text growth with monotonic page time; only lengths are kept, never text.
  await page.evaluate((question) => {
    // The chat viewport only exists once the conversation view replaced the welcome screen.
    const samples = [];
    const base = () =>
      (document.querySelector('[data-radix-scroll-area-viewport]')?.textContent ?? '').replace(question, '').length;
    window.__answerSamples = samples;
    window.__answerStart = () => {
      window.__sentAt = performance.now();
      // Baseline is taken on the first observed chat view (human message only), not the welcome screen.
      let initial;
      const observer = new MutationObserver(() => {
        const current = base();
        if (initial === undefined) {
          if (!document.querySelector('[data-radix-scroll-area-viewport]')) return;
          initial = current;
          return;
        }
        const length = current - initial;
        const last = samples.at(-1);
        if (length > 0 && (!last || length !== last.length)) samples.push({ t: performance.now() - window.__sentAt, length });
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    };
  }, QUESTION);
  await page.evaluate(() => window.__answerStart());
  await page.getByTestId('chat-submit').click();
  await page.getByTestId('chat-cancel').waitFor({ state: 'visible', timeout: 10_000 });
  await page.getByTestId('chat-cancel').waitFor({ state: 'detached', timeout: 180_000 });

  const samples = await page.evaluate(() => window.__answerSamples);
  const gaps = samples.slice(1).map((sample, index) => sample.t - samples[index].t);
  const firstVisibleMs = samples[0]?.t;
  result.samples = samples.length;
  result.firstVisibleMs = firstVisibleMs === undefined ? null : Math.round(firstVisibleMs);
  result.maxGapMs = gaps.length ? Math.round(Math.max(...gaps)) : null;
  result.totalMs = samples.length ? Math.round(samples.at(-1).t) : null;
  check('first visible within the D8 first-chunk limit', firstVisibleMs !== undefined && firstVisibleMs <= firstLimitMs, { limitMs: firstLimitMs });
  check('at least two further updates after the first', samples.length >= 3);
  check('largest gap between updates within the idle limit', result.maxGapMs !== null && result.maxGapMs <= idleLimitMs, { limitMs: idleLimitMs });

  // The authoritative final message must equal what the page shows, and appear once.
  const threads = await (await fetch(new URL('/threads/search', backendUrl), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ limit: 1, sort_by: 'updated_at', sort_order: 'desc' }),
  })).json();
  const state = await (await fetch(new URL(`/threads/${threads[0].thread_id}/state`, backendUrl))).json();
  const aiMessages = state.values.messages.filter((message) => message.type === 'ai');
  const final = typeof aiMessages.at(-1)?.content === 'string' ? aiMessages.at(-1).content : '';
  const pageText = await page.locator('[data-radix-scroll-area-viewport]').innerText();
  const probe = final.slice(0, 40);
  const occurrences = probe ? pageText.split(probe).length - 1 : 0;
  check('thread holds one answer with a message id', aiMessages.length === 1 && typeof aiMessages[0].id === 'string');
  check('final answer shown exactly once', occurrences === 1, { occurrences });
  check('page text matches the final answer', final.length > 0 && pageText.replace(/\s+/g, '').includes(final.replace(/\s+/g, '')), { finalLength: final.length });
  result.finishReason = aiMessages.at(-1)?.response_metadata?.finish_reason ?? null;
  result.answerStreamed = aiMessages.at(-1)?.response_metadata?.answer_streamed ?? null;
  result.providerModel = aiMessages.at(-1)?.response_metadata?.provider_model ?? null;
  result.usage = aiMessages.at(-1)?.usage_metadata ?? null;
  check('answer was streamed, not degraded', result.answerStreamed === true);
  check('usage reported', Boolean(result.usage?.input_tokens) && Boolean(result.usage?.output_tokens));
} catch (error) {
  result.checks.push({ name: 'run', ok: false, error: String(error).slice(0, 300) });
} finally {
  await browser.close();
}

const evidence = { kind: 'answer-stream-live-smoke', measuredAt: new Date().toISOString(), appUrl, ...result, passed: result.checks.every((entry) => entry.ok) };
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
process.exitCode = evidence.passed ? 0 : 1;
