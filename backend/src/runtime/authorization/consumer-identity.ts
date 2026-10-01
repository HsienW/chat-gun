import { z } from "zod";

import type { PrincipalType } from "./principal.js";

export const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export const opaqueIdentityIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(OPAQUE_ID_PATTERN);

export const ACCOUNT_STATUS_VALUES = [
  "pending_verification",
  "active",
  "recovery_restricted",
  "suspended",
  "deletion_pending",
  "deleted",
] as const;

export const SESSION_STATUS_VALUES = [
  "active",
  "expired",
  "revoked",
  "compromised",
] as const;

export const PRINCIPAL_KIND_VALUES = [
  "anonymous",
  "authenticated",
  "service",
  "operator",
  "delegated",
] as const;

export const accountStatusSchema = z.enum(ACCOUNT_STATUS_VALUES);
export const sessionStatusSchema = z.enum(SESSION_STATUS_VALUES);
export const principalKindSchema = z.enum(PRINCIPAL_KIND_VALUES);

export type AccountStatus = z.infer<typeof accountStatusSchema>;
export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type PrincipalKind = z.infer<typeof principalKindSchema>;

export const delegatedIdentitySchema = z
  .object({
    delegatedPrincipalId: opaqueIdentityIdSchema,
    parentPrincipalId: opaqueIdentityIdSchema,
    delegatedCapabilitySet: z
      .array(z.string().min(1).max(128))
      .min(1)
      .max(64),
  })
  .strict();

export type DelegatedIdentity = z.infer<typeof delegatedIdentitySchema>;

export const PRINCIPAL_TYPE_TO_KIND = {
  user: "authenticated",
  merchant_staff: "authenticated",
  platform_staff: "operator",
  service: "service",
} as const satisfies Readonly<Record<PrincipalType, PrincipalKind>>;

export const principalTypeAdapter = {
  version: "1.0.0" as const,
  mapping: PRINCIPAL_TYPE_TO_KIND,
  toPrincipalKind(value: string): PrincipalKind {
    if (!(value in PRINCIPAL_TYPE_TO_KIND)) {
      const error = new Error("UNKNOWN_PRINCIPAL_TYPE");
      Object.defineProperty(error, "code", {
        enumerable: true,
        value: "UNKNOWN_PRINCIPAL_TYPE",
      });
      throw error;
    }
    return PRINCIPAL_TYPE_TO_KIND[
      value as keyof typeof PRINCIPAL_TYPE_TO_KIND
    ];
  },
} as const;
