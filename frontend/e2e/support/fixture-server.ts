import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Same-origin stand-in for what the BFF exposes to the browser (design D1):
 * `/app/` serves the e2e bundle, `/api/langgraph/*` answers from the test's
 * scripted runs, and anything else is recorded as unexpected and refused.
 * The test drives it in-process (gates, scripted runs, request records).
 */

const DIST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist-e2e');
const APP_BASE = '/app/';
const API_BASE = '/api/langgraph';
const FIXED_TIMESTAMP = '2026-10-26T12:00:00.000Z';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

export type RequestRoute =
  | 'static'
  | 'thread.create'
  | 'thread.history'
  | 'run.stream'
  | 'unexpected';

/** What the browser sent, without anything credential-like (there are none). */
export interface RecordedRequest {
  index: number;
  method: string;
  path: string;
  route: RequestRoute;
  headers: {
    requestId?: string;
    idempotencyKey?: string;
    activeRunId?: string;
  };
  body?: RunRequestBody;
  runId?: string;
  /** The browser closed the connection before the response ended. */
  closedBeforeEnd: boolean;
  ended: boolean;
  /** Writes the script attempted after the browser had closed the connection. */
  lateWriteAttempts: number;
}

export interface RunRequestBody {
  input: Record<string, unknown> | null;
  command?: { resume?: unknown };
  kind?: string;
  targetRunId?: string;
  resume?: unknown;
  inputKind?: string;
  interruptId?: string;
  streamMode?: unknown;
}

export interface ThreadMessage {
  type: 'human' | 'ai' | 'tool';
  id: string;
  content: unknown;
  [key: string]: unknown;
}

export class FixtureThread {
  values: Record<string, unknown> = { messages: [] };
  interrupts: unknown[] = [];
  private checkpoint = 0;

  constructor(readonly id: string) {}

  get messages(): ThreadMessage[] {
    const messages = this.values.messages;
    return Array.isArray(messages) ? (messages as ThreadMessage[]) : [];
  }

  /** One authoritative head state, shaped like the LangGraph thread history. */
  historyStates(): unknown[] {
    this.checkpoint += 1;
    const waiting = this.interrupts.length > 0;
    return [
      {
        values: this.values,
        next: waiting ? ['agent'] : [],
        tasks: waiting
          ? [
              {
                id: 'task-1',
                name: 'agent',
                error: null,
                interrupts: this.interrupts.map((value) => ({
                  value,
                  when: 'during',
                  resumable: true,
                  ns: ['agent:1'],
                })),
                state: null,
              },
            ]
          : [],
        checkpoint: {
          thread_id: this.id,
          checkpoint_ns: '',
          checkpoint_id: `checkpoint-${this.checkpoint}`,
          checkpoint_map: null,
        },
        parent_checkpoint: null,
        metadata: {},
        created_at: FIXED_TIMESTAMP,
      },
    ];
  }
}

export interface RunContext {
  readonly runId: string;
  readonly thread: FixtureThread;
  readonly body: RunRequestBody;
  /** Human messages the browser sent in this run's input. */
  readonly inputMessages: ThreadMessage[];
  readonly closed: boolean;
  /** Writes one SSE frame; after the browser closed the connection it only counts the attempt. */
  send(event: string, data: unknown): void;
  /** Replaces the thread values and streams them as one `values` frame. */
  values(values: Record<string, unknown>): void;
  /** Streams a LangGraph `updates` frame (node key to update). */
  update(update: Record<string, unknown>): void;
  /** Ends the stream with a structured error frame shaped like the BFF's. */
  error(envelope: unknown): void;
  /** Resolves when the test releases this gate; nothing after it is sent before. */
  gate(name: string): Promise<void>;
}

export type RunScript = (run: RunContext) => Promise<void> | void;

/** A scripted response for a run stream request that never reaches a stream. */
export interface RunHttpError {
  status: number;
  body: unknown;
}

type RunStep = RunScript | RunHttpError;

interface Gate {
  reached: boolean;
  released: boolean;
  release: () => void;
  promise: Promise<void>;
  reachedWaiters: Array<() => void>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function parseRunBody(raw: string): RunRequestBody {
  const record = asRecord(JSON.parse(raw)) ?? {};
  const input = asRecord(record.input) ?? null;
  const command = asRecord(record.command);
  const metadata = asRecord(asRecord(asRecord(record.config)?.configurable)?.clientInteractionMetadata);
  return {
    input,
    ...(command ? { command } : {}),
    ...(typeof input?.kind === 'string' ? { kind: input.kind } : {}),
    ...(typeof input?.targetRunId === 'string' ? { targetRunId: input.targetRunId } : {}),
    ...(command && 'resume' in command ? { resume: command.resume } : {}),
    ...(typeof metadata?.inputKind === 'string' ? { inputKind: metadata.inputKind } : {}),
    ...(typeof metadata?.interruptId === 'string' ? { interruptId: metadata.interruptId } : {}),
    streamMode: record.stream_mode,
  };
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

export class FixtureServer {
  readonly requests: RecordedRequest[] = [];
  readonly externalRequests: string[] = [];
  private readonly runSteps: RunStep[] = [];
  private readonly gates = new Map<string, Gate>();
  private readonly threads = new Map<string, FixtureThread>();
  private readonly scriptErrors: unknown[] = [];
  private readonly server = createServer((request, response) => {
    void this.handle(request, response);
  });
  private runCount = 0;
  private origin_ = '';

  get origin(): string {
    return this.origin_;
  }

  get appUrl(): string {
    return `${this.origin_}${APP_BASE}`;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.origin_ = `http://127.0.0.1:${port}`;
  }

  async close(): Promise<void> {
    for (const gate of this.gates.values()) gate.release();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Queues the next run stream responses, consumed in request order. */
  onRun(...steps: RunStep[]): void {
    this.runSteps.push(...steps);
  }

  release(name: string): void {
    this.getGate(name).release();
  }

  /** Resolves once a script is parked on the gate, so a test knows the fixture holds. */
  gateReached(name: string): Promise<void> {
    const gate = this.getGate(name);
    if (gate.reached) return Promise.resolve();
    return new Promise((resolve) => gate.reachedWaiters.push(resolve));
  }

  thread(id: string): FixtureThread | undefined {
    return this.threads.get(id);
  }

  runRequests(): RecordedRequest[] {
    return this.requests.filter((request) => request.route === 'run.stream');
  }

  apiRequests(): RecordedRequest[] {
    return this.requests.filter((request) => request.route !== 'static');
  }

  recordExternal(url: string): void {
    this.externalRequests.push(url);
  }

  /** Problems that fail the test (design D5). */
  violations(): string[] {
    return [
      ...this.requests
        .filter((request) => request.route === 'unexpected')
        .map((request) => `unexpected request: ${request.method} ${request.path}`),
      ...this.externalRequests.map((url) => `external connection: ${url}`),
      ...this.scriptErrors.map((error) => `scenario script failed: ${String(error)}`),
      ...(this.runSteps.length > 0 ? [`${this.runSteps.length} scripted run(s) never requested`] : []),
    ];
  }

  /** For harness self-tests that provoke a violation on purpose. */
  clearViolations(): void {
    for (const request of this.requests) {
      if (request.route === 'unexpected') request.route = 'static';
    }
    this.externalRequests.length = 0;
  }

  private getGate(name: string): Gate {
    let gate = this.gates.get(name);
    if (!gate) {
      let resolve = () => {};
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      const created: Gate = {
        reached: false,
        released: false,
        promise,
        reachedWaiters: [],
        release: () => {
          created.released = true;
          resolve();
        },
      };
      gate = created;
      this.gates.set(name, gate);
    }
    return gate;
  }

  private record(request: IncomingMessage, route: RequestRoute, response: ServerResponse): RecordedRequest {
    const recorded: RecordedRequest = {
      index: this.requests.length,
      method: request.method ?? 'GET',
      path: new URL(request.url ?? '/', 'http://fixture').pathname,
      route,
      headers: {
        requestId: headerValue(request, 'x-request-id'),
        idempotencyKey: headerValue(request, 'x-idempotency-key'),
        activeRunId: headerValue(request, 'x-active-run-id'),
      },
      closedBeforeEnd: false,
      ended: false,
      lateWriteAttempts: 0,
    };
    response.on('finish', () => {
      recorded.ended = true;
    });
    response.on('close', () => {
      if (!response.writableFinished) recorded.closedBeforeEnd = true;
    });
    this.requests.push(recorded);
    return recorded;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://fixture');
    const method = request.method ?? 'GET';

    if (method === 'GET' && url.pathname.startsWith(APP_BASE)) {
      await this.serveStatic(url.pathname, request, response);
      return;
    }

    if (method === 'POST' && url.pathname === `${API_BASE}/threads`) {
      this.record(request, 'thread.create', response);
      await readBody(request);
      const id = `thread-${this.threads.size + 1}`;
      this.threads.set(id, new FixtureThread(id));
      writeJson(response, 200, {
        thread_id: id,
        created_at: FIXED_TIMESTAMP,
        updated_at: FIXED_TIMESTAMP,
        metadata: {},
        status: 'idle',
        values: null,
      });
      return;
    }

    const threadRoute = url.pathname.match(/^\/api\/langgraph\/threads\/([^/]+)\/(history|runs\/stream)$/);
    const thread = threadRoute ? this.threads.get(threadRoute[1]) : undefined;
    if (method === 'POST' && thread && threadRoute?.[2] === 'history') {
      this.record(request, 'thread.history', response);
      await readBody(request);
      writeJson(response, 200, thread.historyStates());
      return;
    }
    if (method === 'POST' && thread && threadRoute?.[2] === 'runs/stream') {
      const step = this.runSteps.shift();
      const recorded = this.record(request, step ? 'run.stream' : 'unexpected', response);
      const raw = await readBody(request);
      recorded.body = parseRunBody(raw);
      if (!step) {
        writeJson(response, 409, { error: 'no scripted run for this request' });
        return;
      }
      await this.runStream(step, thread, recorded, response);
      return;
    }

    this.record(request, 'unexpected', response);
    await readBody(request);
    writeJson(response, 404, { error: 'not defined by the scenario' });
  }

  private async serveStatic(
    pathname: string,
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const relative = decodeURIComponent(pathname.slice(APP_BASE.length));
    const filePath = path.resolve(DIST_DIR, relative || 'index.html');
    if (!filePath.startsWith(DIST_DIR)) {
      this.record(request, 'unexpected', response);
      writeJson(response, 404, { error: 'outside the bundle' });
      return;
    }
    const target = path.extname(filePath) ? filePath : path.join(DIST_DIR, 'index.html');
    try {
      const content = await readFile(target);
      this.record(request, 'static', response);
      response.writeHead(200, {
        'content-type': CONTENT_TYPES[path.extname(target)] ?? 'application/octet-stream',
      });
      response.end(content);
    } catch {
      this.record(request, 'unexpected', response);
      writeJson(response, 404, { error: 'not in the bundle' });
    }
  }

  private async runStream(
    step: RunStep,
    thread: FixtureThread,
    recorded: RecordedRequest,
    response: ServerResponse
  ): Promise<void> {
    if (typeof step !== 'function') {
      writeJson(response, step.status, step.body);
      return;
    }

    this.runCount += 1;
    const runId = `run-${this.runCount}`;
    recorded.runId = runId;
    let closed = false;
    // The response closes when the browser drops the connection (or after it ends).
    response.on('close', () => {
      closed = true;
    });

    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.flushHeaders();

    const send = (event: string, data: unknown) => {
      if (closed || response.writableEnded) {
        recorded.lateWriteAttempts += 1;
        return;
      }
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const inputMessages = Array.isArray(recorded.body?.input?.messages)
      ? (recorded.body.input.messages as ThreadMessage[])
      : [];

    const context: RunContext = {
      runId,
      thread,
      body: recorded.body ?? { input: null },
      inputMessages,
      get closed() {
        return closed;
      },
      send,
      values: (values) => {
        // A run the browser disconnected from is cancelled upstream (on_disconnect),
        // so its later output never becomes thread state.
        if (!closed) thread.values = values;
        send('values', values);
      },
      update: (update) => send('updates', update),
      error: (envelope) => {
        send('error', envelope);
        if (!closed) response.end();
      },
      gate: async (name) => {
        const gate = this.getGate(name);
        gate.reached = true;
        gate.reachedWaiters.splice(0).forEach((resolve) => resolve());
        await gate.promise;
      },
    };

    send('metadata', { run_id: runId, attempt: 1 });
    try {
      await step(context);
    } catch (error) {
      this.scriptErrors.push(error);
    }
    if (!closed && !response.writableEnded) response.end();
  }
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const server = new FixtureServer();
  await server.start();
  return server;
}
