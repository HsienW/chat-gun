import { MANIFEST_SCHEMA_VERSION } from "@gun-ai/harness-contracts";
import { describe, expect, it } from "vitest";

import { assertHostManifestVersionCompatible } from "./manifest-version-compatibility.js";

describe("host SDK manifest compatibility", () => {
  it("accepts the reviewed manifest version through the X26 compatibility set", () => {
    expect(() => assertHostManifestVersionCompatible(MANIFEST_SCHEMA_VERSION, "current_weather")).not.toThrow();
  });

  it("returns the X26 typed failure for an untested manifest version", () => {
    expect(() => assertHostManifestVersionCompatible("9.0.0", "current_weather")).toThrowError(
      expect.objectContaining({
        code: "RUNTIME_VERSION_UNTESTED",
        correlation: { toolId: "current_weather" },
      })
    );
  });

  it("keeps a legacy tool without manifest provenance compatible", () => {
    expect(() => assertHostManifestVersionCompatible(undefined, "calculator_tool")).not.toThrow();
  });
});
