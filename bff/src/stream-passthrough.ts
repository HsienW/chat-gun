import type { Writable } from "node:stream";

import {
  createBffAbortError,
  isBffAbortReason,
  type BffAbortReason,
} from "./errors.js";

export type StreamPipeResult = {
  completed: boolean;
  clientDisconnected: boolean;
};

export async function pipeWebResponseBody(
  body: ReadableStream<Uint8Array>,
  response: Writable,
  options: {
    abortController: AbortController;
    disconnectReason: BffAbortReason;
  }
): Promise<StreamPipeResult> {
  const reader = body.getReader();
  let completed = false;
  let clientDisconnected = false;

  const onClose = () => {
    if (completed || response.writableEnded) return;
    clientDisconnected = true;
    if (!options.abortController.signal.aborted) {
      options.abortController.abort(options.disconnectReason);
    }
    void reader.cancel(options.disconnectReason).catch(() => undefined);
  };

  response.on("close", onClose);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (clientDisconnected || response.destroyed) break;
      if (value && !response.write(value)) {
        await new Promise<void>((resolve) => {
          const onDrain = () => {
            response.off("close", onClosed);
            resolve();
          };
          const onClosed = () => {
            response.off("drain", onDrain);
            resolve();
          };
          response.once("drain", onDrain);
          response.once("close", onClosed);
        });
      }
    }
    completed = !clientDisconnected;
    if (completed && !response.writableEnded) response.end();
    return { completed, clientDisconnected };
  } catch (error) {
    if (clientDisconnected) {
      throw createBffAbortError(options.disconnectReason, error);
    }
    const abortReason = getAbortReason(options.abortController.signal);
    if (abortReason) {
      throw createBffAbortError(abortReason, error);
    }
    throw error;
  } finally {
    response.off("close", onClose);
    reader.releaseLock();
  }
}

function getAbortReason(signal: AbortSignal): BffAbortReason | undefined {
  return isBffAbortReason(signal.reason) ? signal.reason : undefined;
}
