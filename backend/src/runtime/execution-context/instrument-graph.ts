import type { ExecutionContext } from "./execution-context.js";
import { withExecutionContext } from "./read-execution-context.js";

type ContextResolver = (input: unknown, config: unknown) => ExecutionContext | undefined;

const STREAM_METHODS = new Set<PropertyKey>(["stream", "streamEvents", "streamLog"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value !== null &&
    typeof value === "object" &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function";
}

function prepareConfig(input: unknown, config: unknown, resolveContext: ContextResolver): unknown {
  const context = resolveContext(input, config);
  if (context === undefined) return config;
  const runnableConfig = isRecord(config) ? config : {};
  const configurable = isRecord(runnableConfig.configurable)
    ? runnableConfig.configurable
    : {};
  const trustedMetadataRemoved = Object.fromEntries(
    Object.entries(configurable).filter(([key]) =>
      key !== "execution_context" && !key.startsWith("x-bff-")
    )
  );
  return withExecutionContext({
    ...runnableConfig,
    configurable: trustedMetadataRemoved,
  }, context);
}

export function instrumentGraphWithExecutionContext<TGraph extends object>(
  graph: TGraph,
  resolveContext: ContextResolver
): TGraph {
  return new Proxy(graph, {
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver);
      if (typeof member !== "function") return member;
      if (property === "invoke") {
        return (input: unknown, config?: unknown) =>
          Reflect.apply(member, target, [input, prepareConfig(input, config, resolveContext)]);
      }
      if (STREAM_METHODS.has(property)) {
        return (input: unknown, config?: unknown): AsyncIterable<unknown> =>
          (async function* streamWithContext() {
            const prepared = prepareConfig(input, config, resolveContext);
            const stream: unknown = await Reflect.apply(member, target, [input, prepared]);
            if (!isAsyncIterable(stream)) {
              throw new TypeError("Graph stream method did not return an AsyncIterable");
            }
            yield* stream;
          })();
      }
      return member.bind(target);
    },
  });
}
