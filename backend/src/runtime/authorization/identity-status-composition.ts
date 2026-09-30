import { getAgentRuntimeConfig } from "../../platform/runtime-config.js";
import { getPool } from "../persistence/connection.js";
import type { ExecutionContextInstrumentationOptions } from "../execution-context/instrument-graph.js";
import { PgRuntimeIdentityStatusPort } from "./identity-status.js";

export function getRuntimeIdentityStatusInstrumentation(): ExecutionContextInstrumentationOptions {
  const enabled = getAgentRuntimeConfig().identityStatusEnforcementEnabled;
  if (!enabled) return {};
  const pool = getPool();
  if (!pool) {
    throw new Error(
      "IDENTITY_STATUS_ENFORCEMENT_ENABLED requires DATABASE_URL",
    );
  }
  return {
    identityStatus: {
      enabled: true,
      port: new PgRuntimeIdentityStatusPort(pool),
      protectedPath: () => process.env.NODE_ENV !== "development",
    },
  };
}
