import type { ExecutionContext } from "./execution-context.js";
import { withExecutionContext } from "./read-execution-context.js";
import {
  enforceRuntimeIdentityStatus,
  type RuntimeIdentityStatusPort,
} from "../authorization/identity-status.js";
import {
  recordExecutionContextCorrelations,
  type SubjectCorrelationIndexPort,
} from "../data-governance/subject-correlation-index.js";

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

function prepareConfig(input: unknown, config: unknown, resolveContext: ContextResolver): {
  prepared: unknown;
  context: ExecutionContext | undefined;
} {
  const context = resolveContext(input, config);
  if (context === undefined) return { prepared: config, context };
  const runnableConfig = isRecord(config) ? config : {};
  const configurable = isRecord(runnableConfig.configurable)
    ? runnableConfig.configurable
    : {};
  const trustedMetadataRemoved = Object.fromEntries(
    Object.entries(configurable).filter(([key]) =>
      key !== "execution_context" && !key.startsWith("x-bff-")
    )
  );
  return {
    prepared: withExecutionContext({
      ...runnableConfig,
      configurable: trustedMetadataRemoved,
    }, context),
    context,
  };
}

export type IdentityStatusInstrumentation = {
  enabled: boolean;
  port: RuntimeIdentityStatusPort;
  protectedPath: (input: unknown, config: unknown) => boolean;
};

export type ExecutionContextInstrumentationOptions = {
  identityStatus?: IdentityStatusInstrumentation;
  subjectCorrelationIndex?: SubjectCorrelationIndexPort;
};

async function prepareConfigWithIdentityStatus(
  input: unknown,
  config: unknown,
  resolveContext: ContextResolver,
  options: ExecutionContextInstrumentationOptions,
): Promise<unknown> {
  const { prepared, context } = prepareConfig(input, config, resolveContext);
  if (!context) return prepared;
  if (options.identityStatus) {
    await enforceRuntimeIdentityStatus(context, {
      enabled: options.identityStatus.enabled,
      protectedPath: options.identityStatus.protectedPath(input, config),
      port: options.identityStatus.port,
    });
  }
  if (options.subjectCorrelationIndex) {
    await recordExecutionContextCorrelations(options.subjectCorrelationIndex, context);
  }
  return prepared;
}

export function instrumentGraphWithExecutionContext<TGraph extends object>(
  graph: TGraph,
  resolveContext: ContextResolver,
  options: ExecutionContextInstrumentationOptions = {},
): TGraph {
  return new Proxy(graph, {
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver);
      if (typeof member !== "function") return member;
      if (property === "invoke") {
        return async (input: unknown, config?: unknown) => {
          const prepared = await prepareConfigWithIdentityStatus(
            input,
            config,
            resolveContext,
            options,
          );
          return Reflect.apply(member, target, [input, prepared]);
        };
      }
      if (STREAM_METHODS.has(property)) {
        return (input: unknown, config?: unknown): AsyncIterable<unknown> =>
          (async function* streamWithContext() {
            const prepared = await prepareConfigWithIdentityStatus(
              input,
              config,
              resolveContext,
              options,
            );
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
