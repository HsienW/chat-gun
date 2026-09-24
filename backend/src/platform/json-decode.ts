import { createHash } from "node:crypto";

export type JsonDecodeFailureKind = "incomplete" | "invalid" | "too_large";

export type JsonDecodeResult<T> =
  | { status: "valid"; value: T }
  | { status: "aborted" }
  | {
      status: "incomplete";
      errorCode: "JSON_DECODE_INCOMPLETE";
      rawHash: string;
      byteLength: number;
    }
  | {
      status: "invalid";
      errorCode: "JSON_DECODE_INVALID";
      rawHash: string;
      byteLength: number;
    }
  | {
      status: "too_large";
      errorCode: "JSON_DECODE_MAX_BYTES" | "JSON_DECODE_MAX_DEPTH";
      byteLength: number;
    };

export interface JsonDecodeOptions {
  maxBytes: number;
  maxDepth: number;
  signal?: AbortSignal;
}

type StructureScan =
  | { status: "within_limit"; isIncomplete: boolean }
  | { status: "too_deep" };

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}

function scanJsonStructure(text: string, maxDepth: number): StructureScan {
  const expectedClosers: string[] = [];
  let isInString = false;
  let isEscaped = false;
  let hasMismatchedCloser = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (isInString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (character === "\\") {
        isEscaped = true;
      } else if (character === '"') {
        isInString = false;
      }
      continue;
    }

    if (character === '"') {
      isInString = true;
      continue;
    }

    if (character === "{" || character === "[") {
      expectedClosers.push(character === "{" ? "}" : "]");
      if (expectedClosers.length > maxDepth) {
        return { status: "too_deep" };
      }
      continue;
    }

    if (character === "}" || character === "]") {
      if (expectedClosers.at(-1) !== character) {
        hasMismatchedCloser = true;
      } else {
        expectedClosers.pop();
      }
    }
  }

  return {
    status: "within_limit",
    isIncomplete:
      !hasMismatchedCloser &&
      (isInString || isEscaped || expectedClosers.length > 0),
  };
}

function hashJsonText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function decodeJsonText<T = unknown>(
  text: string,
  options: JsonDecodeOptions
): JsonDecodeResult<T> {
  if (options.signal?.aborted) {
    return { status: "aborted" };
  }

  assertPositiveInteger("maxBytes", options.maxBytes);
  assertPositiveInteger("maxDepth", options.maxDepth);

  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > options.maxBytes) {
    return {
      status: "too_large",
      errorCode: "JSON_DECODE_MAX_BYTES",
      byteLength,
    };
  }

  const structure = scanJsonStructure(text, options.maxDepth);
  if (structure.status === "too_deep") {
    return {
      status: "too_large",
      errorCode: "JSON_DECODE_MAX_DEPTH",
      byteLength,
    };
  }

  try {
    return {
      status: "valid",
      value: JSON.parse(text) as T,
    };
  } catch {
    const rawHash = hashJsonText(text);
    return structure.isIncomplete
      ? {
          status: "incomplete",
          errorCode: "JSON_DECODE_INCOMPLETE",
          rawHash,
          byteLength,
        }
      : {
          status: "invalid",
          errorCode: "JSON_DECODE_INVALID",
          rawHash,
          byteLength,
        };
  }
}
