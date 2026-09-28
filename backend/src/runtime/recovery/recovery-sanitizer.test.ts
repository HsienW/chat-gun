import { describe, expect, it } from "vitest";

import type { ExecutionManifestRef } from "./interrupt-manifest.js";
import { sanitizeRecoveryHistory } from "./recovery-sanitizer.js";

const currentManifest: ExecutionManifestRef = {
  manifestVersion: "1.0.0",
  graphId: "deep_researcher",
  graphConfigHash: "a".repeat(64),
  schemaVersions: {
    runtimeEventEnvelope: "1.0.0",
    toolDescriptor: "1.0",
    authorizationPolicy: "1.0",
    normalizedInput: "1.0",
  },
};

function sanitize(
  messages: readonly unknown[],
  persistedExecutionManifest: ExecutionManifestRef = currentManifest
) {
  return sanitizeRecoveryHistory({
    messages,
    persistedExecutionManifest,
    currentExecutionManifest: currentManifest,
  });
}

describe("RecoverySanitizer", () => {
  it("accepts a structurally complete tool call/result history", () => {
    expect(
      sanitize([
        { id: "m-1", role: "user", content: "question" },
        {
          id: "m-2",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-1",
              name: "weather",
              arguments: { location: "Taipei" },
              argumentState: "complete",
            },
          ],
        },
        {
          id: "m-3",
          role: "tool",
          toolCallId: "call-1",
          resultState: "active",
          content: { status: "success" },
        },
      ])
    ).toMatchObject({ status: "valid" });
  });

  it("parks unmatched tool calls and sanitizes duplicate or orphan results", () => {
    expect(
      sanitize([
        {
          id: "m-1",
          role: "assistant",
          toolCalls: [
            {
              id: "call-1",
              name: "write",
              arguments: {},
              argumentState: "complete",
            },
          ],
        },
      ])
    ).toMatchObject({
      status: "parked",
      reasonCodes: expect.arrayContaining(["UNMATCHED_TOOL_CALL"]),
    });

    const duplicate = sanitize([
      {
        id: "m-1",
        role: "assistant",
        toolCalls: [
          {
            id: "call-1",
            name: "read",
            arguments: {},
            argumentState: "complete",
          },
        ],
      },
      { id: "m-2", role: "tool", toolCallId: "call-1", resultState: "active" },
      { id: "m-3", role: "tool", toolCallId: "call-1", resultState: "active" },
      { id: "m-4", role: "tool", toolCallId: "missing", resultState: "active" },
    ]);
    expect(duplicate).toMatchObject({ status: "sanitized" });
    if (duplicate.status === "sanitized") {
      expect(duplicate.reasonCodes).toEqual(
        expect.arrayContaining(["DUPLICATE_TOOL_RESULT", "UNMATCHED_TOOL_RESULT"])
      );
      expect(duplicate.history.map((message) => message.id)).toEqual([
        "m-1",
        "m-2",
      ]);
    }
  });

  it.each(["incomplete", "invalid"] as const)(
    "parks %s tool argument fragments",
    (argumentState) => {
      expect(
        sanitize([
          {
            id: "m-1",
            role: "assistant",
            toolCalls: [
              { id: "call-1", name: "write", arguments: "{", argumentState },
            ],
          },
        ])
      ).toMatchObject({
        status: "parked",
        reasonCodes: expect.arrayContaining(["INCOMPLETE_TOOL_ARGUMENTS"]),
      });
    }
  );

  it("drops orphaned thinking/content blocks without inventing replacements", () => {
    const output = sanitize([
      {
        id: "m-1",
        role: "assistant",
        contentBlocks: [
          { blockId: "block-1", type: "thinking", parentMessageId: "missing" },
          { blockId: "block-2", type: "content", parentMessageId: "m-1" },
        ],
      },
    ]);
    expect(output).toMatchObject({
      status: "sanitized",
      reasonCodes: ["ORPHANED_CONTENT_BLOCK"],
    });
    expect(JSON.stringify(output)).not.toContain("thinking text");
  });

  it("drops partial assistant messages", () => {
    const output = sanitize([
      { id: "m-1", role: "user", content: "question" },
      { id: "m-2", role: "assistant", status: "partial", content: "partial" },
    ]);
    expect(output).toMatchObject({
      status: "sanitized",
      reasonCodes: ["PARTIAL_ASSISTANT_MESSAGE"],
    });
    if (output.status === "sanitized") {
      expect(output.history.map((message) => message.id)).toEqual(["m-1"]);
    }
  });

  it("parks invalid legacy enum/config values", () => {
    expect(
      sanitize([
        {
          id: "m-1",
          role: "assistant",
          legacyConfig: { kind: "run_status", value: "mystery" },
        },
      ])
    ).toMatchObject({
      status: "parked",
      reasonCodes: expect.arrayContaining(["INVALID_LEGACY_VALUE"]),
    });
  });

  it("parks already-terminal tool results", () => {
    expect(
      sanitize([
        {
          id: "m-1",
          role: "assistant",
          toolCalls: [
            {
              id: "call-1",
              name: "write",
              arguments: {},
              argumentState: "complete",
            },
          ],
        },
        {
          id: "m-2",
          role: "tool",
          toolCallId: "call-1",
          resultState: "terminal",
        },
      ])
    ).toMatchObject({
      status: "parked",
      reasonCodes: expect.arrayContaining(["ALREADY_TERMINAL_TOOL_RESULT"]),
    });
  });

  it("parks incompatible execution manifests", () => {
    expect(
      sanitize([], { ...currentManifest, graphConfigHash: "b".repeat(64) })
    ).toMatchObject({
      status: "parked",
      reasonCodes: ["INCOMPATIBLE_EXECUTION_MANIFEST"],
    });
  });

  it("parks history whose structure cannot be proven valid with redacted diagnostics", () => {
    const output = sanitize([{ role: "assistant", content: "secret-value" }]);
    expect(output).toMatchObject({
      status: "parked",
      reasonCodes: ["UNPROVABLE_HISTORY"],
      diagnostics: [
        expect.objectContaining({ reasonCode: "UNPROVABLE_HISTORY", index: 0 }),
      ],
    });
    expect(JSON.stringify(output)).not.toContain("secret-value");
  });
});
