import type { AgentRuntimeEvent } from '@/types/agent-runtime-events';
import type { RunStatus, RunTerminalStatus } from '@/lib/runtime-run-status';

const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  running: '執行中',
  needs_user: '等待使用者',
  manual_intervention_required: '需要人工介入',
  completed: '已完成',
  failed: '失敗',
  cancelled: '已取消',
  timed_out: '逾時',
  crashed: '執行崩潰',
  budget_exhausted: '預算用盡',
  superseded: '已被取代',
};

export const RUNTIME_EVENT_NODE_KEYS = {
  buildContextPack: 'build_context_pack',
  planResearch: 'plan_research',
  targetedTools: 'targeted_tools',
  searchWeb: 'search_web',
  fetchSources: 'fetch_sources',
  rankSources: 'rank_sources',
  extractEvidence: 'extract_evidence',
  verifyCitations: 'verify_citations',
  synthesizeAnswer: 'synthesize_answer',
} as const;

export const RUNTIME_EVENT_LABELS = {
  timelineTitle: '研究流程',
  loadingStart: '研究流程啟動中...',
  loading: '研究流程執行中...',
  emptyTitle: '尚無執行事件',
  emptyDescription: 'Timeline 會在 Agent 回傳流程事件後更新',
  plan: '研究規劃',
  planCreated: '已建立任務規劃。',
  toolStarted: (toolName: string) => `工具啟動：${toolName}`,
  toolSuccess: (toolName: string) => `工具完成：${toolName}`,
  toolError: (toolName: string) => `工具錯誤：${toolName}`,
  contextBuilt: '上下文已建立',
  finalAnswer: '最終回答',
  card: (cardType: string) => `卡片：${cardType}`,
  unknown: (eventType: string) => `未知流程事件：${eventType}`,
  runStatus: (status: RunStatus) => `執行狀態：${RUN_STATUS_LABELS[status]}`,
  runTerminal: (status: RunTerminalStatus) =>
    `執行終止：${RUN_STATUS_LABELS[status]}`,
  contextSources: {
    message: (index: number, role: string) => `近期訊息 ${index}（${role}）`,
    asset: (index: number) => `附件 ${index}`,
    tool: (index: number) => `工具資料 ${index}`,
    fallback: '上下文來源',
  },
} as const;

export const RUNTIME_EVENT_ICON_BY_TYPE: Partial<
  Record<AgentRuntimeEvent['type'], 'loading' | 'plan' | 'tool' | 'context' | 'answer'>
> = {
  'agent.tool.start': 'loading',
  'agent.plan.start': 'plan',
  'agent.tool.success': 'tool',
  'agent.tool.error': 'tool',
  'agent.context.build': 'context',
  'agent.answer.stream': 'answer',
};
