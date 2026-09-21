export type ContextSource = {
  sourceId: string;
  sourceType: 'message' | 'asset' | 'tool' | 'business_card' | 'profile';
  title: string;
  summary?: string;
};

export type ExecutionEventCorrelation = {
  requestId: string;
  threadId: string;
  runId: string;
};

export type AgentRuntimeEvent = (
  | { type: 'agent.plan.start'; title: string; ts: number }
  | { type: 'agent.tool.start'; toolName: string; input?: unknown; ts: number }
  | {
      type: 'agent.tool.success';
      toolName: string;
      output?: unknown;
      costMs: number;
      ts: number;
    }
  | { type: 'agent.tool.error'; toolName: string; error: string; ts: number }
  | {
      type: 'agent.context.build';
      sources: ContextSource[];
      tokenEstimate: number;
      ts: number;
    }
  | { type: 'agent.answer.stream'; delta: string; ts: number }
  | { type: 'agent.card.emit'; cardType: string; payload: unknown; ts: number }
  | {
      type: 'agent.unknown';
      originalType: string;
      rawPayload?: Record<string, unknown>;
      ts: number;
    }
) & { correlation?: ExecutionEventCorrelation };
