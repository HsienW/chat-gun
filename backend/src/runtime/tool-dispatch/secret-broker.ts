import { z } from "zod";

import type { ExecutionContext } from "../execution-context/execution-context.js";

export const secretLeaseSchema = z
  .object({
    leaseId: z.string().min(1).optional(),
    expiresAt: z.string().datetime(),
  })
  .strict();

export const secretReferenceSchema = z
  .object({
    secretRef: z.string().min(1),
    secretName: z.string().min(1),
    scope: z.string().min(1),
    lease: secretLeaseSchema.optional(),
  })
  .strict();

export type SecretReference = z.infer<typeof secretReferenceSchema>;

export interface ResolvedSecretCredential {
  value: string;
  leaseId?: string;
  expiresAt?: string;
}

export interface SecretBrokerPort {
  resolve(
    reference: SecretReference,
    executionContext: ExecutionContext
  ): Promise<ResolvedSecretCredential>;
  release?(credential: ResolvedSecretCredential): Promise<void>;
}

export const SECRET_REFERENCE_UNRESOLVABLE =
  "SECRET_REFERENCE_UNRESOLVABLE" as const;

export class SecretBrokerError extends Error {
  readonly name = "SecretBrokerError";

  constructor(
    readonly code: typeof SECRET_REFERENCE_UNRESOLVABLE,
    message: string
  ) {
    super(message);
  }
}

export interface EnvironmentSecretBrokerDependencies {
  references: Readonly<Record<string, string>>;
  readEnvironment?: (name: string) => string | undefined;
  now?: () => Date;
}

function isUsableSecret(value: string | undefined): value is string {
  if (value === undefined || value.trim().length === 0) return false;
  return ![
    "changeme",
    "your_api_key",
    "your_api_key_here",
    "your_tavily_api_key",
    "your_tavily_api_key_here",
  ].includes(value.trim().toLowerCase());
}

export class EnvironmentSecretBroker implements SecretBrokerPort {
  constructor(private readonly dependencies: EnvironmentSecretBrokerDependencies) {}

  async resolve(
    reference: SecretReference,
    _executionContext: ExecutionContext
  ): Promise<ResolvedSecretCredential> {
    const parsed = secretReferenceSchema.parse(reference);
    const environmentName = this.dependencies.references[parsed.secretRef];
    const now = this.dependencies.now?.() ?? new Date();
    const expired =
      parsed.lease !== undefined &&
      new Date(parsed.lease.expiresAt).getTime() <= now.getTime();
    if (
      environmentName === undefined ||
      environmentName !== parsed.secretName ||
      expired
    ) {
      throw new SecretBrokerError(
        SECRET_REFERENCE_UNRESOLVABLE,
        `Secret reference cannot be resolved: ${parsed.secretRef}`
      );
    }

    const value = (this.dependencies.readEnvironment ??
      ((name: string) => process.env[name]))(environmentName);
    if (!isUsableSecret(value)) {
      throw new SecretBrokerError(
        SECRET_REFERENCE_UNRESOLVABLE,
        `Secret reference cannot be resolved: ${parsed.secretRef}`
      );
    }

    return {
      value,
      ...(parsed.lease?.leaseId ? { leaseId: parsed.lease.leaseId } : {}),
      ...(parsed.lease?.expiresAt ? { expiresAt: parsed.lease.expiresAt } : {}),
    };
  }
}

const RESOLVED_SECRET_CONTEXT = Symbol("resolved-secret-context");

interface SecretBearingConfig extends Record<PropertyKey, unknown> {
  configurable?: SecretBearingConfig;
  [RESOLVED_SECRET_CONTEXT]?: ReadonlyMap<string, string>;
}

export function withResolvedSecrets(
  config: unknown,
  credentials: Readonly<Record<string, string>>
): SecretBearingConfig {
  const base =
    config !== null && typeof config === "object"
      ? (config as SecretBearingConfig)
      : {};
  const configurable =
    base.configurable !== null && typeof base.configurable === "object"
      ? base.configurable
      : {};
  const merged = new Map(configurable[RESOLVED_SECRET_CONTEXT] ?? []);
  for (const [secretRef, value] of Object.entries(credentials)) {
    merged.set(secretRef, value);
  }
  return {
    ...base,
    configurable: {
      ...configurable,
      [RESOLVED_SECRET_CONTEXT]: merged,
    },
  };
}

export function readResolvedSecret(
  config: unknown,
  secretRef: string
): string | undefined {
  if (config === null || typeof config !== "object") return undefined;
  const secretConfig = config as SecretBearingConfig;
  return (
    secretConfig.configurable?.[RESOLVED_SECRET_CONTEXT] ??
    secretConfig[RESOLVED_SECRET_CONTEXT]
  )?.get(secretRef);
}
