import { describe, expect, it } from "vitest";
import { assertResumeVersionCompatible, evaluateRuntimeVersionCompatibility } from "./version-compatibility.js";

const VERSION = { schemaVersion: "20", eventVersion: "1.0.0", packageVersion: "0.1.0", checkpointVersion: "1" };

describe("runtime mixed-version compatibility", () => {
  it("accepts a CI-tested combination and marks untested combinations unknown", () => {
    expect(evaluateRuntimeVersionCompatibility({ observed: VERSION, supported: [VERSION] })).toEqual({ status: "compatible" });
    expect(evaluateRuntimeVersionCompatibility({ observed: { ...VERSION, packageVersion: "0.2.0" }, supported: [VERSION] })).toMatchObject({ status: "unknown" });
  });

  it("rejects explicitly incompatible checkpoint combinations before resume", () => {
    const result = evaluateRuntimeVersionCompatibility({ observed: VERSION, supported: [], explicitlyIncompatible: [VERSION] });
    expect(() => assertResumeVersionCompatible(result)).toThrow("RUNTIME_VERSION_INCOMPATIBLE");
  });
});
