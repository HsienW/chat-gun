import { describe, expect, it } from "vitest";

import {
  createRawInputReference,
  normalizeInputText,
  parseNormalizedAgentInput,
} from "./normalized-agent-input.js";

describe("NormalizedAgentInput", () => {
  it("parses every supported input kind", () => {
    expect(
      parseNormalizedAgentInput({ kind: "prompt", text: "  cafe\u0301\u0000  " }),
    ).toEqual({
      ok: true,
      input: { kind: "prompt", text: "café", attachments: [] },
    });
    expect(
      parseNormalizedAgentInput({
        kind: "clarification_resume",
        interruptId: "interrupt-1",
        value: { answer: "Taipei" },
      }),
    ).toMatchObject({ ok: true });
    expect(parseNormalizedAgentInput({ kind: "cancel" })).toEqual({
      ok: true,
      input: { kind: "cancel" },
    });
    expect(
      parseNormalizedAgentInput({ kind: "cancel", targetRunId: "run-1" }),
    ).toMatchObject({ ok: true });
    expect(
      parseNormalizedAgentInput({ kind: "command", commandId: "refresh" }),
    ).toMatchObject({ ok: true });
  });

  it("rejects unknown kinds and unknown fields", () => {
    expect(parseNormalizedAgentInput({ kind: "mystery" })).toMatchObject({
      ok: false,
      errorCode: "unsupported_input_kind",
    });
    expect(
      parseNormalizedAgentInput({ kind: "cancel", unexpected: true }),
    ).toMatchObject({ ok: false, errorCode: "invalid_input" });
  });

  it("rejects empty prompts and invalid attachment references", () => {
    expect(
      parseNormalizedAgentInput({ kind: "prompt", text: " \u0000\t " }),
    ).toMatchObject({ ok: false, errorCode: "empty_input" });
    expect(
      parseNormalizedAgentInput({
        kind: "prompt",
        text: "file",
        attachments: [
          {
            attachmentId: "../secret",
            name: "example.png",
            contentType: "image/png",
            sizeBytes: 128,
          },
        ],
      }),
    ).toMatchObject({ ok: false, errorCode: "invalid_attachment" });

    expect(
      parseNormalizedAgentInput({
        kind: "prompt",
        text: "file",
        attachments: [
          {
            attachmentId: "attachment-1",
            name: "example.png",
            contentType: "image/png",
          },
        ],
      }),
    ).toMatchObject({ ok: false, errorCode: "invalid_attachment" });
  });

  it("normalizes text deterministically and stores only a digest reference", () => {
    const raw = { text: "  cafe\u0301\r\n\u0000  ", token: "not-persisted" };

    expect(normalizeInputText(raw.text)).toBe("café");

    const reference = createRawInputReference(raw);
    expect(reference).toEqual({
      algorithm: "sha256",
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      byteLength: expect.any(Number),
    });
    expect(JSON.stringify(reference)).not.toContain(raw.text);
    expect(JSON.stringify(reference)).not.toContain(raw.token);
  });
});
