import {
  decodeJsonText,
  type JsonDecodeResult,
} from "./json-decode.js";

export type AssemblerResult = JsonDecodeResult<unknown>;

export interface BoundedAssemblerOptions {
  maxBytes: number;
  maxDepth: number;
  deadlineMs: number;
  signal?: AbortSignal;
}

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number.`);
  }
}

export class BoundedJsonStreamAssembler {
  private readonly encoder = new TextEncoder();
  private decoder = new TextDecoder();
  private text = "";
  private byteLength = 0;
  private depth = 0;
  private isInString = false;
  private isEscaped = false;
  private terminalResult: AssemblerResult | undefined;

  constructor(private readonly options: BoundedAssemblerOptions) {
    assertPositiveFinite("maxBytes", options.maxBytes);
    assertPositiveFinite("maxDepth", options.maxDepth);
    assertPositiveFinite("deadlineMs", options.deadlineMs);
  }

  push(chunk: string | Uint8Array): AssemblerResult {
    if (this.terminalResult) return this.terminalResult;
    if (this.shouldAbort()) return this.stop({ status: "aborted" });

    const chunkByteLength = typeof chunk === "string"
      ? Buffer.byteLength(chunk, "utf8")
      : chunk.byteLength;
    const nextByteLength = this.byteLength + chunkByteLength;
    if (nextByteLength > this.options.maxBytes) {
      return this.stop({
        status: "too_large",
        errorCode: "JSON_DECODE_MAX_BYTES",
        byteLength: nextByteLength,
      });
    }

    const bytes = typeof chunk === "string" ? this.encoder.encode(chunk) : chunk;
    const decodedChunk = this.decoder.decode(bytes, { stream: true });
    if (this.scanChunk(decodedChunk)) {
      return this.stop({
        status: "too_large",
        errorCode: "JSON_DECODE_MAX_DEPTH",
        byteLength: nextByteLength,
      });
    }

    this.byteLength = nextByteLength;
    this.text += decodedChunk;
    const currentResult = this.decodeCurrent();
    return currentResult.status === "aborted" || currentResult.status === "too_large"
      ? this.stop(currentResult)
      : currentResult;
  }

  end(): AssemblerResult {
    if (this.terminalResult) return this.terminalResult;
    if (this.shouldAbort()) return this.stop({ status: "aborted" });

    const decodedTail = this.decoder.decode();
    if (decodedTail) {
      if (this.scanChunk(decodedTail)) {
        return this.stop({
          status: "too_large",
          errorCode: "JSON_DECODE_MAX_DEPTH",
          byteLength: this.byteLength,
        });
      }
      this.text += decodedTail;
    }

    return this.stop(this.decodeCurrent());
  }

  abort(_reason?: unknown): void {
    if (!this.terminalResult) {
      this.stop({ status: "aborted" });
    }
  }

  private decodeCurrent(): AssemblerResult {
    return decodeJsonText(this.text, {
      maxBytes: this.options.maxBytes,
      maxDepth: this.options.maxDepth,
      signal: this.options.signal,
    });
  }

  private shouldAbort(): boolean {
    return this.options.signal?.aborted === true || Date.now() >= this.options.deadlineMs;
  }

  private scanChunk(chunk: string): boolean {
    for (let index = 0; index < chunk.length; index += 1) {
      const character = chunk[index];

      if (this.isInString) {
        if (this.isEscaped) {
          this.isEscaped = false;
        } else if (character === "\\") {
          this.isEscaped = true;
        } else if (character === '"') {
          this.isInString = false;
        }
        continue;
      }

      if (character === '"') {
        this.isInString = true;
      } else if (character === "{" || character === "[") {
        this.depth += 1;
        if (this.depth > this.options.maxDepth) return true;
      } else if ((character === "}" || character === "]") && this.depth > 0) {
        this.depth -= 1;
      }
    }
    return false;
  }

  private stop(result: AssemblerResult): AssemblerResult {
    this.terminalResult = result;
    this.text = "";
    this.byteLength = 0;
    this.depth = 0;
    this.isInString = false;
    this.isEscaped = false;
    this.decoder = new TextDecoder();
    return result;
  }
}
