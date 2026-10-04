import { REDACTED_MARKER } from "../audit/redaction.js";

const SENSITIVE_CHECKPOINT_KEY =
  /^(?:api[_-]?key|authorization|cookie|credential|password|secret|token)$/i;

function redactValue(value: unknown, visited: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (visited.has(value)) return REDACTED_MARKER;
  visited.add(value);

  if (Array.isArray(value)) {
    const result = value.map((entry) => redactValue(entry, visited));
    visited.delete(value);
    return result;
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = SENSITIVE_CHECKPOINT_KEY.test(key)
      ? REDACTED_MARKER
      : redactValue(entry, visited);
  }
  visited.delete(value);
  return result;
}

export function redactCheckpointUpdate(value: unknown): unknown {
  return redactValue(value, new WeakSet());
}
