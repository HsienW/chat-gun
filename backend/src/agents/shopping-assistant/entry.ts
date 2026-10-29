import type { RunnableConfig } from "@langchain/core/runnables";

import { getEnv } from "../../platform/env.js";
import {
  createGraphEntryContextResolver,
  type GraphTaskAdmission,
} from "../../runtime/execution-context/graph-entry.js";
import { PgGraphTaskAdmission } from "../../runtime/execution-context/graph-task-admission.js";
import {
  readDevelopmentExecutionContext,
  readExecutionContext,
} from "../../runtime/execution-context/read-execution-context.js";

function resolveShoppingExecutionContext(input: unknown, config: unknown) {
  return getEnv("TOOL_AUTHORIZATION_PROFILE", "production") === "development"
    ? readDevelopmentExecutionContext(input, config)
    : readExecutionContext(input, config, "production");
}

/**
 * The shopping entry admits a server task for each new input and reattaches a
 * resume to the task saved in the checkpoint (design §6.15).
 */
export function createShoppingAssistantEntryResolver(
  graph: { getState(config: RunnableConfig): Promise<{ values: unknown }> },
  admission: GraphTaskAdmission = new PgGraphTaskAdmission(),
) {
  return createGraphEntryContextResolver(graph, admission, resolveShoppingExecutionContext);
}
