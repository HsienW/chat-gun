import { z } from "zod";

const versionSetSchema = z.object({
  schemaVersion: z.string().trim().min(1),
  eventVersion: z.string().trim().min(1),
  packageVersion: z.string().trim().min(1),
  checkpointVersion: z.string().trim().min(1).optional(),
}).strict();

export type RuntimeVersionSet = z.infer<typeof versionSetSchema>;
export type VersionCompatibility =
  | { status: "compatible" }
  | { status: "incompatible"; errorCode: "RUNTIME_VERSION_INCOMPATIBLE" }
  | { status: "unknown"; errorCode: "RUNTIME_VERSION_UNTESTED" };

export function evaluateRuntimeVersionCompatibility(input: {
  observed: unknown;
  supported: readonly RuntimeVersionSet[];
  explicitlyIncompatible?: readonly RuntimeVersionSet[];
}): VersionCompatibility {
  const observed = versionSetSchema.parse(input.observed);
  const key = (versions: RuntimeVersionSet) => JSON.stringify(versions);
  if ((input.explicitlyIncompatible ?? []).some((versions) => key(versions) === key(observed))) {
    return { status: "incompatible", errorCode: "RUNTIME_VERSION_INCOMPATIBLE" };
  }
  if (input.supported.some((versions) => key(versions) === key(observed))) {
    return { status: "compatible" };
  }
  return { status: "unknown", errorCode: "RUNTIME_VERSION_UNTESTED" };
}

export function assertResumeVersionCompatible(result: VersionCompatibility): void {
  if (result.status !== "compatible") {
    const error = new Error(result.errorCode) as Error & { code: string };
    error.code = result.errorCode;
    throw error;
  }
}
