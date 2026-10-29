import { MANIFEST_SCHEMA_VERSION } from "@gun-ai/harness-contracts";
import { defineAgent } from "@gun-ai/harness-sdk";

import { KB_SEARCH_TOOL_NAME } from "../../tools/kb-search.js";
import {
  ORDER_CANCEL_TOOL_NAME,
  ORDER_OPERATION_STATUS_TOOL_NAME,
  ORDER_REFUND_REQUEST_TOOL_NAME,
  ORDER_TOOL_VERSION,
} from "../../tools/orders/order-contracts.js";
import { LOCAL_RUNTIME_TOOL_VERSION } from "../../tools/production-runtime-tool-descriptors.js";

export const SHOPPING_ASSISTANT_AGENT_ID = "shopping_assistant";

/** The only tools the shopping graph may load (design §5.4). */
export const SHOPPING_ASSISTANT_AGENT_MANIFEST = defineAgent({
  kind: "agent",
  manifestVersion: MANIFEST_SCHEMA_VERSION,
  agentId: SHOPPING_ASSISTANT_AGENT_ID,
  agentVersion: "1.0.0",
  description: "Shopping assistant: product lookup, policy answers and approved mock order operations.",
  tools: [
    { toolId: KB_SEARCH_TOOL_NAME, toolVersion: LOCAL_RUNTIME_TOOL_VERSION },
    { toolId: ORDER_REFUND_REQUEST_TOOL_NAME, toolVersion: ORDER_TOOL_VERSION },
    { toolId: ORDER_CANCEL_TOOL_NAME, toolVersion: ORDER_TOOL_VERSION },
    { toolId: ORDER_OPERATION_STATUS_TOOL_NAME, toolVersion: ORDER_TOOL_VERSION },
  ],
});
