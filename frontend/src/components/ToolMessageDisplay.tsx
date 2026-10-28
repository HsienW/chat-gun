import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from './ui/collapsible';
import { Badge } from './ui/badge';
import {
  ChevronRight,
  Wrench,
  Clock,
  CheckCircle,
  XCircle,
  AlertTriangle,
} from 'lucide-react';
import { ToolCall, ToolMessage } from '@/types/tools';
import { cn } from '@/lib/utils';
import { formatErrorEnvelope, parseErrorEnvelope } from '@/types/errors';
import {
  WeatherToolResultCard,
  type ClarificationReplyPayload,
} from './WeatherToolResult';
import {
  parseWeatherToolResult,
  getWeatherDisplayStatus,
  isWeatherToolName,
} from '@/types/weather';

interface ToolMessageDisplayProps {
  toolCall: ToolCall;
  toolMessage?: ToolMessage;
  isExpanded: boolean;
  onToggle: () => void;
  isResumingClarification?: boolean;
  onClarificationReply?: (payload: ClarificationReplyPayload) => void;
  onClarificationCancel?: () => void;
}

const getStatusBadge = (toolCall: ToolCall, toolMessage?: ToolMessage) => {
  // Check for weather tool structured result
  if (toolMessage && isWeatherToolName(toolCall.name)) {
    const weatherResult = parseWeatherToolResult(toolMessage.content);
    if (weatherResult) {
      const status = getWeatherDisplayStatus(weatherResult);

      switch (status) {
        case 'success':
          return (
            <Badge
              variant="default"
              className="mr-2 bg-green-500/10 text-green-500 border-green-500/20 text-xs font-medium"
            >
              <CheckCircle className="h-3 w-3 mr-1" />
              完成
            </Badge>
          );
        case 'needs_clarification':
          return (
            <Badge
              variant="default"
              className="mr-2 bg-blue-500/10 text-blue-400 border-blue-500/20 text-xs font-medium"
            >
              <AlertTriangle className="h-3 w-3 mr-1" />
              需補充地點
            </Badge>
          );
        case 'not_found':
          return (
            <Badge
              variant="default"
              className="mr-2 bg-yellow-500/10 text-yellow-400 border-yellow-500/20 text-xs font-medium"
            >
              找不到地點
            </Badge>
          );
        case 'error':
        case 'timeout':
        case 'cancelled':
          return (
            <Badge
              variant="destructive"
              className="bg-red-500/10 text-red-400 border-red-500/20 text-xs font-medium"
            >
              <XCircle className="h-3 w-3 mr-1" />
              {status === 'timeout' ? '逾時' : status === 'cancelled' ? '已取消' : '錯誤'}
            </Badge>
          );
        case 'unknown':
          return (
            <Badge
              variant="secondary"
              className="mr-2 bg-gray-500/10 text-gray-400 border-gray-500/20 text-xs font-medium"
            >
              <AlertTriangle className="h-3 w-3 mr-1" />
              未知結果
            </Badge>
          );
        default:
          break;
      }
    }
  }

  // Handle legacy/unknown weather results — Task 6.6, 6.7
  if (toolMessage && isWeatherToolName(toolCall.name) && !parseWeatherToolResult(toolMessage.content)) {
    // Legacy format — show as "完成" since the agent did get data
    return (
      <Badge
        variant="default"
        className="mr-2 bg-green-500/10 text-green-500 border-green-500/20 text-xs font-medium"
      >
        <CheckCircle className="h-3 w-3 mr-1" />
        完成
      </Badge>
    );
  }

  if (!toolMessage) {
    return (
      <Badge
        variant="secondary"
        className="bg-amber-500/10 text-amber-500 border-amber-500/20 text-xs font-medium"
      >
        <Clock className="h-3 w-3 mr-1" />
        執行中
      </Badge>
    );
  }

  if (toolMessage.is_error || parseErrorEnvelope(toolMessage.content)) {
    return (
      <Badge
        variant="destructive"
        className="bg-red-500/10 text-red-400 border-red-500/20 text-xs font-medium"
      >
        <XCircle className="h-3 w-3 mr-1" />
        錯誤
      </Badge>
    );
  }

  return (
    <Badge
      variant="default"
      className="mr-2 bg-green-500/10 text-green-500 border-green-500/20 text-xs font-medium"
    >
      <CheckCircle className="h-3 w-3 mr-1" />
      完成
    </Badge>
  );
};

const JsonDisplay = ({ data, title }: { data: unknown; title: string }) => (
  <div className="space-y-2">
    <h4 className="text-xs font-medium text-[#E7D9C1]/70 uppercase tracking-wider">
      {title}
    </h4>
    <div className="bg-[#2B1C17]/70 rounded-lg p-3 border border-[#5A4036]/70 overflow-x-auto">
      <pre className="text-xs overflow-x-auto text-[#F8F1E7] font-mono leading-relaxed whitespace-pre-wrap break-words min-w-0">
        <code>{JSON.stringify(data, null, 2)}</code>
      </pre>
    </div>
  </div>
);

export function ToolMessageDisplay({
  toolCall,
  toolMessage,
  isExpanded,
  onToggle,
  isResumingClarification = false,
  onClarificationReply,
  onClarificationCancel,
}: ToolMessageDisplayProps) {
  const errorEnvelope = parseErrorEnvelope(toolMessage?.content);
  const displayContent = errorEnvelope
    ? formatErrorEnvelope(errorEnvelope)
    : toolMessage?.content;

  // Check if this is a weather tool result that should use the WeatherToolResultCard
  const isWeatherTool = isWeatherToolName(toolCall.name) && toolMessage;
  const weatherResult = isWeatherTool ? parseWeatherToolResult(toolMessage!.content) : undefined;
  const isStructuredWeather = weatherResult !== undefined;

  return (
    <div className="border border-border bg-card/70 rounded-lg overflow-hidden mt-4 mb-2 min-w-0">
      <Collapsible open={isExpanded} onOpenChange={onToggle}>
        <CollapsibleTrigger asChild>
          <button className="w-full px-4 py-3 hover:bg-muted transition-all duration-200 text-left focus:outline-none focus:bg-muted">
            <div className="flex items-center justify-between min-w-0">
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <div className="p-1.5 rounded-md bg-[#7A1E1E]/25 flex-shrink-0">
                    <Wrench className="h-3.5 w-3.5 text-[#E7D9C1]" />
                  </div>
                  <div className="flex flex-col gap-1 min-w-0 flex-1">
                    <span className="font-medium text-[#F8F1E7] text-sm truncate">
                      {toolCall.name}
                    </span>
                  </div>
                </div>
                <div className="flex-shrink-0">
                  {getStatusBadge(toolCall, toolMessage)}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                <ChevronRight
                  className={cn(
                    'h-4 w-4 text-[#E7D9C1]/70 transition-transform duration-200',
                    isExpanded && 'rotate-90'
                  )}
                />
              </div>
            </div>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent
          className={cn(
            'data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up'
          )}
        >
          <div className="px-4 pb-4 space-y-4 border-t border-border overflow-x-auto">
            <div className="pt-4 min-w-0">
              {Object.keys(toolCall.args).length > 0 && (
                <JsonDisplay data={toolCall.args} title="輸入" />
              )}

              {toolMessage && (
                <div className="space-y-2 mt-4">
                  <h4 className="text-xs font-medium text-[#E7D9C1]/70 uppercase tracking-wider">
                    輸出
                  </h4>
                  {/* Weather structured result card — Task 6.2 */}
                  {isStructuredWeather ? (
                    <WeatherToolResultCard
                      content={toolMessage.content}
                      isResuming={isResumingClarification}
                      onClarificationReply={onClarificationReply}
                      onClarificationCancel={onClarificationCancel}
                    />
                  ) : (
                    <div
                      className={cn(
                        'rounded-lg p-3 text-sm border overflow-x-auto',
                        toolMessage.is_error
                          ? 'bg-red-900/10 border-red-500/20 text-red-200'
                          : 'bg-[#2B1C17]/70 border-[#5A4036]/70 text-[#F8F1E7]'
                      )}
                    >
                      {typeof displayContent === 'string' ? (
                        <pre className="whitespace-pre-wrap overflow-x-auto font-mono text-xs leading-relaxed break-words min-w-0">
                          {displayContent}
                        </pre>
                      ) : (
                        <pre className="overflow-x-auto font-mono text-xs leading-relaxed min-w-0">
                          <code className="whitespace-pre-wrap break-words">
                            {JSON.stringify(displayContent, null, 2)}
                          </code>
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              )}

              {!toolMessage && (
                <div className="text-xs text-[#E7D9C1]/60 italic mt-4 p-3 bg-[#2B1C17]/40 rounded-lg border border-[#5A4036]/50">
                  <div className="flex items-center gap-2">
                    <Clock className="h-3 w-3 animate-pulse flex-shrink-0" />
                    <span>等待 tool response...</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
