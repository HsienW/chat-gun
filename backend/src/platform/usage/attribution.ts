export const REGISTERED_GRAPH_IDS = Object.freeze({
  chatbot: "chatbot",
  deepResearcher: "deep_researcher",
  shoppingAssistant: "shopping_assistant",
  mathAgent: "math_agent",
  mcpAgent: "mcp_agent",
} as const);
export type RegisteredGraphId = typeof REGISTERED_GRAPH_IDS[keyof typeof REGISTERED_GRAPH_IDS];
export type UsageAttribution = Readonly<{ graphId: RegisteredGraphId }>;
export const USAGE_ATTRIBUTION_KEY = "__server_usage_attribution";
const registeredIds: ReadonlySet<string> = new Set(Object.values(REGISTERED_GRAPH_IDS));
const streamMethods: ReadonlySet<PropertyKey> = new Set(["stream", "streamEvents", "streamLog"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRegisteredGraphId(value: unknown): value is RegisteredGraphId {
  return typeof value === "string" && registeredIds.has(value);
}

export function readUsageAttribution(config: unknown): UsageAttribution | undefined {
  if (!isRecord(config) || !isRecord(config.configurable)) return undefined;
  const attribution = config.configurable[USAGE_ATTRIBUTION_KEY];
  return isRecord(attribution) && Object.keys(attribution).length === 1 && isRegisteredGraphId(attribution.graphId)
    ? { graphId: attribution.graphId }
    : undefined;
}

function withoutClientAttribution(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== USAGE_ATTRIBUTION_KEY));
}

function prepareUsageConfig(config: unknown, graphId: RegisteredGraphId): Record<string, unknown> {
  const source = isRecord(config) ? config : {};
  const configurable = isRecord(source.configurable) ? source.configurable : {};
  return { ...withoutClientAttribution(source), configurable: {
    ...withoutClientAttribution(configurable),
    [USAGE_ATTRIBUTION_KEY]: Object.freeze({ graphId }),
  } };
}

function cleanInput(input: unknown): unknown {
  // Preserve Command and other class instances; attribution is never read from input.
  return isRecord(input) && Object.getPrototypeOf(input) === Object.prototype
    ? withoutClientAttribution(input)
    : input;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return isRecord(value) && Symbol.asyncIterator in value && typeof value[Symbol.asyncIterator] === "function";
}

/** The registered export owns graph identity before any inner instrumentation runs. */
export function instrumentGraphWithUsageAttribution<TGraph extends object>(graph: TGraph, graphId: RegisteredGraphId): TGraph {
  return new Proxy(graph, {
    get(target, property, receiver) {
      const member: unknown = Reflect.get(target, property, receiver);
      if (typeof member !== "function") return member;
      if (property === "invoke") {
        return (input: unknown, config?: unknown, ...rest: unknown[]) =>
          Reflect.apply(member, target, [cleanInput(input), prepareUsageConfig(config, graphId), ...rest]);
      }
      if (streamMethods.has(property)) {
        return (input: unknown, config?: unknown, ...rest: unknown[]) => (async function* () {
          const stream: unknown = await Reflect.apply(member, target, [cleanInput(input), prepareUsageConfig(config, graphId), ...rest]);
          if (!isAsyncIterable(stream)) throw new TypeError("Graph stream is not an AsyncIterable");
          yield* stream;
        })();
      }
      if (property === "withConfig") {
        return (...args: unknown[]) => {
          const configured: unknown = Reflect.apply(member, target, args);
          if (!isRecord(configured)) throw new TypeError("Configured graph is not an object");
          return instrumentGraphWithUsageAttribution(configured, graphId);
        };
      }
      return member.bind(target);
    },
  });
}
