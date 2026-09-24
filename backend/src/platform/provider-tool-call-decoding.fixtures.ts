import type { JsonDecodeFailureKind } from "./json-decode.js";

export type ContractDecodeOutcome =
  | "valid"
  | "aborted"
  | JsonDecodeFailureKind
  | "refusal";

export type DecodeContractFixture = {
  name: string;
  expected: ContractDecodeOutcome;
  raw?: string;
  maxBytes: number;
  maxDepth: number;
  abortBeforeDecode?: boolean;
};

export const PROVIDER_TOOL_CALL_DECODING_FIXTURES = [
  {
    name: "valid unicode object",
    expected: "valid",
    raw: '{"value":"台灣🙂"}',
    maxBytes: 1_024,
    maxDepth: 16,
  },
  {
    name: "caller aborted",
    expected: "aborted",
    raw: '{"value":"must-not-be-read"}',
    maxBytes: 1,
    maxDepth: 1,
    abortBeforeDecode: true,
  },
  {
    name: "truncated object",
    expected: "incomplete",
    raw: '{"value":"truncated"',
    maxBytes: 1_024,
    maxDepth: 16,
  },
  {
    name: "invalid object",
    expected: "invalid",
    raw: '{"value":}',
    maxBytes: 1_024,
    maxDepth: 16,
  },
  {
    name: "byte limit exceeded",
    expected: "too_large",
    raw: '{"value":"larger-than-limit"}',
    maxBytes: 8,
    maxDepth: 16,
  },
  {
    name: "provider content filter refusal",
    expected: "refusal",
    maxBytes: 1_024,
    maxDepth: 16,
  },
] as const satisfies readonly DecodeContractFixture[];
