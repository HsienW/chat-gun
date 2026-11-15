// stream-chat-answer-text Task 1.1: controllable OpenAI-compatible Provider fixture.
// Sends the first part of the reply, then holds the connection until GET /release.
// Usage: node mock-provider.mjs <port> <eventLogPath>
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const [portArg, logPath] = process.argv.slice(2);
const port = Number(portArg);
if (!Number.isInteger(port) || !logPath) throw new Error('usage: mock-provider.mjs <port> <eventLogPath>');

const FIRST = 'FIXTURE-FIRST-SEGMENT';
const SECOND = ' FIXTURE-SECOND-SEGMENT';
let releaseWaiters = [];

function log(event, detail = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), monotonicMs: Math.round(performance.now()), event, ...detail });
  appendFileSync(logPath, `${line}\n`);
  console.log(line);
}

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/release') {
    const waiters = releaseWaiters;
    releaseWaiters = [];
    waiters.forEach((resolve) => resolve());
    log('release', { waiters: waiters.length });
    res.end('released');
    return;
  }
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    res.statusCode = 404;
    res.end();
    return;
  }
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', async () => {
    let body = {};
    try { body = JSON.parse(raw); } catch { /* recorded below */ }
    const streamRequested = body.stream === true;
    log('provider.request', { stream: streamRequested, model: body.model ?? null, hasTools: Array.isArray(body.tools) });
    const id = `chatcmpl-fixture-${Date.now()}`;
    const released = new Promise((resolve) => { releaseWaiters.push(resolve); });
    if (streamRequested) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      sse(res, { id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: FIRST } }] });
      log('provider.first_segment_sent', { mode: 'sse' });
      await released;
      sse(res, { id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: SECOND }, finish_reason: 'stop' }] });
      res.end('data: [DONE]\n\n');
    } else {
      const full = JSON.stringify({
        id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model ?? 'fixture-model',
        choices: [{ index: 0, message: { role: 'assistant', content: `${FIRST}${SECOND}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
      });
      // Split inside the answer text so the first segment is on the wire before the gate.
      const cut = full.indexOf(SECOND);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write(full.slice(0, cut));
      log('provider.first_segment_sent', { mode: 'json', bytes: cut });
      await released;
      res.end(full.slice(cut));
    }
    log('provider.response_ended');
  });
});

server.listen(port, '127.0.0.1', () => log('provider.listening', { port }));
