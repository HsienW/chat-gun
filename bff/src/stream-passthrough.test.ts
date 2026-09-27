import assert from "node:assert/strict";
import { test } from "node:test";
import { Writable } from "node:stream";

import { pipeWebResponseBody } from "./stream-passthrough.js";

const encoder = new TextEncoder();

function createBody(chunks: string[], onCancel?: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunk));
    },
    cancel() {
      onCancel?.();
    },
  });
}

test("passes stream bytes and SSE framing through unchanged", async () => {
  const output: Buffer[] = [];
  const response = new Writable({
    write(chunk, _encoding, callback) {
      output.push(Buffer.from(chunk));
      callback();
    },
  });

  const result = await pipeWebResponseBody(
    createBody(["event: runtime\n", 'data: {"sequence":1}\n\n']),
    response,
    {
      abortController: new AbortController(),
      disconnectReason: {
        code: "client_disconnected",
        stage: "langgraph_stream_proxy",
        requestId: "request-1",
      },
    }
  );

  assert.deepEqual(result, { completed: true, clientDisconnected: false });
  assert.equal(Buffer.concat(output).toString("utf8"), 'event: runtime\ndata: {"sequence":1}\n\n');
});

test("honors writable backpressure without concurrent buffered writes", async () => {
  const output: Buffer[] = [];
  let inFlightWrites = 0;
  let maxInFlightWrites = 0;
  const response = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      inFlightWrites += 1;
      maxInFlightWrites = Math.max(maxInFlightWrites, inFlightWrites);
      setImmediate(() => {
        output.push(Buffer.from(chunk));
        inFlightWrites -= 1;
        callback();
      });
    },
  });

  await pipeWebResponseBody(createBody(["one", "two", "three"]), response, {
    abortController: new AbortController(),
    disconnectReason: {
      code: "client_disconnected",
      stage: "langgraph_stream_proxy",
      requestId: "request-2",
    },
  });

  assert.equal(Buffer.concat(output).toString("utf8"), "onetwothree");
  assert.equal(maxInFlightWrites, 1);
});

test("aborts upstream and cancels the reader when downstream closes", async () => {
  let cancelled = false;
  const abortController = new AbortController();
  const response = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
      this.destroy();
    },
  });

  const result = await pipeWebResponseBody(
    createBody(["first", "second"], () => {
      cancelled = true;
    }),
    response,
    {
      abortController,
      disconnectReason: {
        code: "client_disconnected",
        stage: "langgraph_stream_proxy",
        requestId: "request-3",
      },
    }
  );

  assert.deepEqual(result, { completed: false, clientDisconnected: true });
  assert.equal(abortController.signal.aborted, true);
  assert.equal(cancelled, true);
});
