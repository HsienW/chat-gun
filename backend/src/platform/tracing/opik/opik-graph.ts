import { getOpikTracer, type AgentRunMetadata, type OpikTracer } from "./opik-tracer.js";
import { readExecutionCorrelation } from "../../../runtime/execution-context/read-execution-context.js";

const TRACED_STREAM_METHODS = new Set<PropertyKey>([
  "stream",
  "streamEvents",
  "streamLog",
]);

function readAgentRunMetadata(config: unknown): AgentRunMetadata | undefined {
  const { threadId, runId, taskId, requestId } = readExecutionCorrelation(config);
  if (!threadId || !runId) return undefined;
  return {
    threadId,
    runId,
    ...(taskId ? { taskId } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

function readStepId(config: unknown): string | undefined {
  return readExecutionCorrelation(config).stepId;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      Symbol.asyncIterator in value &&
      typeof value[Symbol.asyncIterator] === "function"
  );
}

function isCallable(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}

async function invokeMethod(
  method: (...args: unknown[]) => unknown,
  target: object,
  input: unknown,
  config: unknown
): Promise<unknown> {
  return await Promise.resolve(Reflect.apply(method, target, [input, config]));
}

async function invokeStreamMethod(
  method: (...args: unknown[]) => unknown,
  target: object,
  input: unknown,
  config: unknown
): Promise<AsyncIterable<unknown>> {
  const output = await invokeMethod(method, target, input, config);
  if (!isAsyncIterable(output)) {
    throw new TypeError("Instrumented graph stream method did not return an AsyncIterable");
  }
  return output;
}

function createDeferredStream(
  streamFactory: () => Promise<AsyncIterable<unknown>>
): AsyncIterable<unknown> {
  return (async function* generateDeferredStream() {
    const stream = await streamFactory();
    for await (const chunk of stream) yield chunk;
  })();
}

export function instrumentGraphWithOpik<TGraph extends object>(
  graph: TGraph,
  agentName: string,
  tracer: OpikTracer = getOpikTracer()
): TGraph {
  return new Proxy(graph, {
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver);
      if (!isCallable(member)) return member;

      if (property === "invoke") {
        return async (input: unknown, config?: unknown) => {
          const metadata = readAgentRunMetadata(config);
          const execution = () => invokeMethod(member, target, input, config);
          return metadata && !tracer.getActiveTraceId()
            ? tracer.traceAgentRun(agentName, metadata, execution)
            : execution();
        };
      }

      if (TRACED_STREAM_METHODS.has(property)) {
        return (input: unknown, config?: unknown) => {
          const metadata = readAgentRunMetadata(config);
          const execution = () => invokeStreamMethod(member, target, input, config);
          return metadata && !tracer.getActiveTraceId()
            ? tracer.traceAgentStream(agentName, metadata, execution)
            : createDeferredStream(execution);
        };
      }

      return member.bind(target);
    },
  });
}

export function withOpikNode<TArguments extends unknown[], TResult>(
  nodeName: string,
  node: (...args: TArguments) => Promise<TResult>,
  tracer: OpikTracer = getOpikTracer()
): (...args: TArguments) => Promise<TResult> {
  return (...args) => {
    const stepId = readStepId(args[1]);
    return tracer.withNodeSpan(
      nodeName,
      stepId ? { stepId } : {},
      () => node(...args),
      args[0]
    );
  };
}

export const opikGraphTestInternals = {
  readAgentRunMetadata,
  readStepId,
};
