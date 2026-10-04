import { describe, expect, it } from "vitest";

import { redactCheckpointUpdate } from "./checkpoint-redaction.js";

describe("checkpoint redaction", () => {
  it("redacts secret-bearing fields at the node update write boundary", () => {
    const secretValue = "checkpoint-secret-value";
    const redacted = redactCheckpointUpdate({
      safe: "kept",
      nested: {
        credential: secretValue,
        apiKey: secretValue,
      },
    });

    expect(JSON.stringify(redacted)).not.toContain(secretValue);
    expect(redacted).toMatchObject({
      safe: "kept",
      nested: { credential: "[REDACTED]", apiKey: "[REDACTED]" },
    });
  });
});
