import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Message } from '@langchain/langgraph-sdk';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Copy, CopyCheck } from 'lucide-react';
import { InputForm } from '@/components/InputForm';
import { Button } from '@/components/ui/button';
import ReactMarkdown from 'react-markdown';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import {
  ActivityTimeline,
  ProcessedEvent,
} from '@/components/ActivityTimeline'; // ActivityTimeline 位於同一 components 目錄
import { AVAILABLE_AGENTS } from '@/types/agents';
import { ToolMessageDisplay } from '@/components/ToolMessageDisplay';
import {
  extractImageAttachments,
  extractToolCallsFromMessage,
  findToolMessageForCall,
  messageContentToDisplayText,
} from '@/types/messages';
import { ToolCall } from '@/types/tools';
import type { ProcessedImageAttachment } from '@/lib/image-upload';
import type {
  ClarificationReplyPayload,
  ClarificationResumeValue,
} from '@/components/WeatherToolResult';

type ToolMessageDisplayProps = React.ComponentProps<typeof ToolMessageDisplay>;

const areToolArgsEqual = (
  previousArgs: ToolCall['args'],
  nextArgs: ToolCall['args']
) => JSON.stringify(previousArgs) === JSON.stringify(nextArgs);

const areToolMessagesEqual = (
  previousMessage: ToolMessageDisplayProps['toolMessage'],
  nextMessage: ToolMessageDisplayProps['toolMessage']
) =>
  previousMessage?.id === nextMessage?.id &&
  previousMessage?.tool_call_id === nextMessage?.tool_call_id &&
  previousMessage?.name === nextMessage?.name &&
  previousMessage?.content === nextMessage?.content &&
  previousMessage?.is_error === nextMessage?.is_error;

const areToolMessageDisplayPropsEqual = (
  previousProps: ToolMessageDisplayProps,
  nextProps: ToolMessageDisplayProps
) =>
  previousProps.isExpanded === nextProps.isExpanded &&
  previousProps.toolCall.id === nextProps.toolCall.id &&
  previousProps.toolCall.name === nextProps.toolCall.name &&
  previousProps.toolCall.type === nextProps.toolCall.type &&
  previousProps.isResumingClarification === nextProps.isResumingClarification &&
  previousProps.onClarificationReply === nextProps.onClarificationReply &&
  previousProps.onClarificationCancel === nextProps.onClarificationCancel &&
  areToolArgsEqual(previousProps.toolCall.args, nextProps.toolCall.args) &&
  areToolMessagesEqual(previousProps.toolMessage, nextProps.toolMessage);

const MemoizedToolMessageDisplay = React.memo(
  ToolMessageDisplay,
  areToolMessageDisplayPropsEqual
);

// 將 messages 分組，合併 AI responses 與對應的 tool calls/results
interface MessageGroup {
  id: string;
  type: 'human' | 'ai_complete';
  messages: Message[];
  primaryMessage: Message;
  toolCalls: ToolCall[];
  toolResults: Message[];
}

const groupMessages = (messages: Message[]): MessageGroup[] => {
  const groups: MessageGroup[] = [];
  let currentGroup: MessageGroup | null = null;

  for (const message of messages) {
    if (message.type === 'human') {
      // Human messages 一律獨立成組
      groups.push({
        id: message.id || `human-${Date.now()}`,
        type: 'human',
        messages: [message],
        primaryMessage: message,
        toolCalls: [],
        toolResults: [],
      });
      currentGroup = null;
    } else if (message.type === 'ai') {
      // 建立新的 AI group，或延續既有 group
      if (!currentGroup || currentGroup.type !== 'ai_complete') {
        // 建立新的 AI group
        currentGroup = {
          id: message.id || `ai-${Date.now()}`,
          type: 'ai_complete',
          messages: [message],
          primaryMessage: message,
          toolCalls: [], // 不在 group level 累積 tool calls
          toolResults: [],
        };
        groups.push(currentGroup);
      } else {
        // 加入既有 AI group，用於多個 AI messages 的情況
        currentGroup.messages.push(message);
        // 不累積 tool calls，避免重複
        // 將 primary message 更新成最新且有 content 的 message
        if (
          message.content &&
          typeof message.content === 'string' &&
          message.content.trim()
        ) {
          currentGroup.primaryMessage = message;
        }
      }
    } else if (message.type === 'tool') {
      // Tool results 屬於目前 AI group
      if (currentGroup && currentGroup.type === 'ai_complete') {
        currentGroup.toolResults.push(message);
        currentGroup.messages.push(message);
      }
    }
  }

  return groups;
};

// Markdown components，源自舊版 ReportView.tsx
const mdComponents = {
  h1: ({
    className,
    children,
    ...props
  }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h1 className={cn('text-2xl font-bold mt-4 mb-2', className)} {...props}>
      {children}
    </h1>
  ),
  h2: ({
    className,
    children,
    ...props
  }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h2 className={cn('text-xl font-bold mt-3 mb-2', className)} {...props}>
      {children}
    </h2>
  ),
  h3: ({
    className,
    children,
    ...props
  }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h3 className={cn('text-lg font-bold mt-3 mb-1', className)} {...props}>
      {children}
    </h3>
  ),
  p: ({
    className,
    children,
    ...props
  }: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p className={cn('mb-3 leading-7', className)} {...props}>
      {children}
    </p>
  ),
  a: ({
    className,
    children,
    href,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <Badge className="text-xs mx-0.5">
      <a
        className={cn('text-[#7A1E1E] hover:text-[#9F3434] text-xs', className)}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        {...props}
      >
        {children}
      </a>
    </Badge>
  ),
  ul: ({
    className,
    children,
    ...props
  }: React.HTMLAttributes<HTMLUListElement>) => (
    <ul className={cn('list-disc pl-6 mb-3', className)} {...props}>
      {children}
    </ul>
  ),
  ol: ({
    className,
    children,
    ...props
  }: React.HTMLAttributes<HTMLOListElement>) => (
    <ol className={cn('list-decimal pl-6 mb-3', className)} {...props}>
      {children}
    </ol>
  ),
  li: ({
    className,
    children,
    ...props
  }: React.HTMLAttributes<HTMLLIElement>) => (
    <li className={cn('mb-1', className)} {...props}>
      {children}
    </li>
  ),
  blockquote: ({
    className,
    children,
    ...props
  }: React.HTMLAttributes<HTMLQuoteElement>) => (
    <blockquote
      className={cn(
        'border-l-4 border-[#7A1E1E] pl-4 italic my-3 text-sm text-[#E7D9C1]/80',
        className
      )}
      {...props}
    >
      {children}
    </blockquote>
  ),
  code: ({
    className,
    children,
    ...props
  }: React.HTMLAttributes<HTMLElement>) => (
    <code
      className={cn(
        'bg-[#2B1C17] border border-[#5A4036] rounded px-1 py-0.5 font-mono text-xs',
        className
      )}
      {...props}
    >
      {children}
    </code>
  ),
  pre: ({
    className,
    children,
    ...props
  }: React.HTMLAttributes<HTMLPreElement>) => (
    <pre
      className={cn(
        'bg-[#2B1C17] border border-[#5A4036] p-3 rounded-lg overflow-x-auto font-mono text-xs my-3',
        className
      )}
      {...props}
    >
      {children}
    </pre>
  ),
  hr: ({ className, ...props }: React.HTMLAttributes<HTMLHRElement>) => (
    <hr className={cn('border-[#5A4036] my-4', className)} {...props} />
  ),
  table: ({
    className,
    children,
    ...props
  }: React.TableHTMLAttributes<HTMLTableElement>) => (
    <div className="my-3 overflow-x-auto">
      <table className={cn('border-collapse w-full', className)} {...props}>
        {children}
      </table>
    </div>
  ),
  th: ({
    className,
    children,
    ...props
  }: React.ThHTMLAttributes<HTMLTableHeaderCellElement>) => (
    <th
      className={cn(
        'border border-[#5A4036] px-3 py-2 text-left font-bold',
        className
      )}
      {...props}
    >
      {children}
    </th>
  ),
  td: ({
    className,
    children,
    ...props
  }: React.TdHTMLAttributes<HTMLTableDataCellElement>) => (
    <td
      className={cn('border border-[#5A4036] px-3 py-2', className)}
      {...props}
    >
      {children}
    </td>
  ),
};

const messageBubbleClass =
  'text-[#FFF7ED] rounded-3xl break-words bg-[#6e3030] max-w-[100%] sm:max-w-[90%] px-4 py-4 shadow-lg shadow-black/10';

// HumanMessageBubble props
interface HumanMessageBubbleProps {
  group: MessageGroup;
  mdComponents: typeof mdComponents;
}

// HumanMessageBubble component
const HumanMessageBubble = React.memo(function HumanMessageBubble({
  group,
  mdComponents,
}: HumanMessageBubbleProps) {
  const message = group.primaryMessage;
  const imageAttachments = extractImageAttachments(message.content);
  const displayText = messageContentToDisplayText(message.content);

  return (
    <div
      className={cn(messageBubbleClass, 'min-h-7 rounded-br-lg')}
    >
      {displayText && (
        <ReactMarkdown components={mdComponents}>{displayText}</ReactMarkdown>
      )}
      {imageAttachments.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {imageAttachments.map((attachment, index) => (
            <figure
              key={`${attachment.fileName ?? 'image'}-${index}`}
              className="overflow-hidden rounded-2xl border border-[#5A4036] bg-[#160F0C]"
            >
              <img
                src={attachment.url}
                alt={attachment.fileName ?? `uploaded image ${index + 1}`}
                className="h-32 w-full object-cover"
              />
              <figcaption className="truncate px-2 py-1 text-[11px] text-[#E7D9C1]/70">
                {attachment.fileName ?? attachment.mimeType ?? 'uploaded image'}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      {!displayText && imageAttachments.length === 0 && (
        <ReactMarkdown components={mdComponents}>
          {JSON.stringify(message.content)}
        </ReactMarkdown>
      )}
    </div>
  );
});

// AiMessageBubble props
interface AiMessageBubbleProps {
  group: MessageGroup;
  historicalActivity: ProcessedEvent[] | undefined;
  liveActivity: ProcessedEvent[] | undefined;
  isLastGroup: boolean;
  isOverallLoading: boolean;
  mdComponents: typeof mdComponents;
  handleCopy: (text: string, messageId: string) => void;
  copiedMessageId: string | null;
  selectedAgentId: string;
  allMessages: Message[];
  onClarificationReply: (payload: ClarificationReplyPayload) => void;
  onClarificationCancel: () => void;
}

// AiMessageBubble component
const AiMessageBubble = React.memo(function AiMessageBubble({
  group,
  historicalActivity,
  liveActivity,
  isLastGroup,
  isOverallLoading,
  mdComponents,
  handleCopy,
  copiedMessageId,
  selectedAgentId,
  allMessages,
  onClarificationReply,
  onClarificationCancel,
}: AiMessageBubbleProps) {
  // Tool message state
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());

  const toggleTool = useCallback((toolId: string) => {
    setExpandedTools((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(toolId)) {
        newSet.delete(toolId);
      } else {
        newSet.add(toolId);
      }
      return newSet;
    });
  }, []);

  // 判斷要顯示哪些 activity events，以及是否屬於 live loading message
  const activityForThisBubble =
    isLastGroup && isOverallLoading ? liveActivity : historicalActivity;
  const isLiveActivityForThisBubble = isLastGroup && isOverallLoading;

  // 取得目前 agent configuration
  const currentAgent = AVAILABLE_AGENTS.find(
    (agent) => agent.id === selectedAgentId
  );
  const shouldShowActivity =
    currentAgent?.showActivityTimeline &&
    (isLiveActivityForThisBubble ||
      (activityForThisBubble && activityForThisBubble.length > 0));

  // 檢查是否要對 DeepResearcher 隱藏 tool messages
  const shouldHideToolMessages = false;

  // 檢查是否要隱藏 copy button，也就是此 message group 仍在 loading 時
  const shouldHideCopyButton = isLastGroup && isOverallLoading;

  // 合併所有文字 content，供 copy 功能使用
  const combinedTextContent = group.messages
    .filter((msg) => msg.type === 'ai' && msg.content)
    .map((msg) => messageContentToDisplayText(msg.content))
    .filter((content) => content.trim())
    .join('\n\n');

  return (
    <div
      className={cn(
        messageBubbleClass,
        'relative flex flex-col group w-fit rounded-bl-lg',
        shouldShowActivity && 'min-h-[56px]'
      )}
    >
      {shouldShowActivity && (
        <div className="mb-3 border-b border-[#7A1E1E]/50 pb-3 text-xs">
          <ActivityTimeline
            processedEvents={activityForThisBubble || []}
            isLoading={isLiveActivityForThisBubble}
          />
        </div>
      )}

      {/* 依時間順序 render messages */}
      {group.messages.map((message, index) => {
        if (message.type === 'ai') {
          const toolCalls = extractToolCallsFromMessage(message);
          const displayText = messageContentToDisplayText(message.content);
          const hasContent = displayText.trim().length > 0;

          return (
            <div key={message.id || `ai-${index}`} className="space-y-3">
              {/* 若存在 AI content，則 render */}
              {hasContent && (
                <ReactMarkdown components={mdComponents}>
                  {displayText}
                </ReactMarkdown>
              )}

              {/* 在觸發 tool calls 的 AI message 後方立即 render tool calls */}
              {!shouldHideToolMessages && toolCalls.length > 0 && (
                <div className="space-y-2">
                  {toolCalls.map((toolCall) => (
                    <MemoizedToolMessageDisplay
                      key={toolCall.id}
                      toolCall={toolCall}
                      toolMessage={
                        findToolMessageForCall(
                          group.messages,
                          toolCall.id,
                          toolCall.name,
                          true
                        ) ??
                        findToolMessageForCall(
                          allMessages,
                          toolCall.id,
                          toolCall.name
                        )
                      }
                      isExpanded={expandedTools.has(toolCall.id)}
                      onToggle={() => toggleTool(toolCall.id)}
                      isResumingClarification={isOverallLoading && isLastGroup}
                      onClarificationReply={onClarificationReply}
                      onClarificationCancel={onClarificationCancel}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        }
        // 略過 tool messages，因為上方已由 ToolMessageDisplay 處理
        return null;
      })}

      {!shouldHideCopyButton && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 self-start mt-2 hover:bg-[#7A1E1E]/25 text-[#E7D9C1]/60 hover:text-[#E7D9C1]"
          onClick={() =>
            handleCopy(combinedTextContent, group.primaryMessage.id!)
          }
        >
          {copiedMessageId === group.primaryMessage.id ? (
            <CopyCheck className="h-3 w-3" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
        </Button>
      )}
    </div>
  );
});

interface ChatMessagesViewProps {
  messages: Message[];
  isLoading: boolean;
  scrollAreaRef: React.RefObject<HTMLDivElement | null>;
  onSubmit: (
    inputValue: string,
    effort: string,
    model: string,
    agentId: string,
    attachments: ProcessedImageAttachment[]
  ) => void;
  onCancel: () => void;
  liveActivityEvents: ProcessedEvent[];
  historicalActivities: Record<string, ProcessedEvent[]>;
  selectedAgentId: string;
  onAgentChange: (agentId: string) => void;
  onClarificationResume?: (resumeValue: ClarificationResumeValue) => void;
  /** Structured commerce cards and approvals, rendered after the messages. */
  commercePanel?: React.ReactNode;
}

export function ChatMessagesView({
  messages,
  isLoading,
  scrollAreaRef,
  onSubmit,
  onCancel,
  liveActivityEvents,
  historicalActivities,
  selectedAgentId,
  onAgentChange,
  onClarificationResume,
  commercePanel,
}: ChatMessagesViewProps) {
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const handleCopy = useCallback(async (text: string, messageId: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMessageId(messageId);
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = setTimeout(() => setCopiedMessageId(null), 2000); // 2 秒後重置
    } catch (err) {
      console.error('複製文字失敗：', err);
    }
  }, []);

  // 將 messages 分組，合併相關 AI responses 與 tool calls
  const handleClarificationReply = useCallback(
    (payload: ClarificationReplyPayload) => {
      onClarificationResume?.(payload);
    },
    [onClarificationResume]
  );

  const handleClarificationCancel = useCallback(() => {
    onClarificationResume?.({ cancel: true });
  }, [onClarificationResume]);

  const messageGroups = useMemo(() => groupMessages(messages), [messages]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <ScrollArea className="flex-1 min-h-0" ref={scrollAreaRef}>
        <div className="p-4 md:p-6 space-y-2 max-w-4xl mx-auto pt-16 pb-4">
          {messageGroups.map((group, index) => {
            const isLast = index === messageGroups.length - 1;
            return (
              <div key={group.id} className="space-y-3">
                <div
                  className={`flex items-start gap-3 ${
                    group.type === 'human' ? 'justify-end' : ''
                  }`}
                >
                  {group.type === 'human' ? (
                    <HumanMessageBubble
                      group={group}
                      mdComponents={mdComponents}
                    />
                  ) : (
                    <AiMessageBubble
                      group={group}
                      historicalActivity={
                        historicalActivities[group.primaryMessage.id!]
                      }
                      liveActivity={liveActivityEvents}
                      isLastGroup={isLast}
                      isOverallLoading={isLoading}
                      mdComponents={mdComponents}
                      handleCopy={handleCopy}
                      copiedMessageId={copiedMessageId}
                      selectedAgentId={selectedAgentId}
                      allMessages={messages}
                      onClarificationReply={handleClarificationReply}
                      onClarificationCancel={handleClarificationCancel}
                    />
                  )}
                </div>
              </div>
            );
          })}
          {commercePanel}
          {isLoading &&
            (messageGroups.length === 0 ||
              messageGroups[messageGroups.length - 1].type === 'human') && (
              <div className="flex items-start gap-3 mt-3">
                {(() => {
                  const currentAgent = AVAILABLE_AGENTS.find(
                    (agent) => agent.id === selectedAgentId
                  );
                  const shouldShowActivity = currentAgent?.showActivityTimeline;

                  if (shouldShowActivity) {
                    return (
                      <div
                        className={cn(
                          messageBubbleClass,
                          'relative group w-fit rounded-bl-lg min-h-[56px]'
                        )}
                      >
                        <div className="text-xs">
                          <ActivityTimeline
                            processedEvents={liveActivityEvents}
                            isLoading={true}
                          />
                        </div>
                      </div>
                    );
                  } else {
                    return (
                      <div className="flex items-center justify-start h-full min-h-[56px]">
                        <div className="flex justify-center items-center gap-1">
                          <div className="w-2 h-2 bg-[#E7D9C1] rounded-full animate-bounce [animation-delay:-0.32s]"></div>
                          <div className="w-2 h-2 bg-[#E7D9C1] rounded-full animate-bounce [animation-delay:-0.16s]"></div>
                          <div className="w-2 h-2 bg-[#E7D9C1] rounded-full animate-bounce"></div>
                        </div>
                      </div>
                    );
                  }
                })()}
              </div>
            )}
        </div>
      </ScrollArea>
      <div className="flex-shrink-0">
        <InputForm
          onSubmit={onSubmit}
          isLoading={isLoading}
          onCancel={onCancel}
          hasHistory={messages.length > 0}
          selectedAgent={selectedAgentId}
          onAgentChange={onAgentChange}
        />
      </div>
    </div>
  );
}
