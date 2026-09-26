import { useStream } from '@langchain/langgraph-sdk/react';
import type { Message } from '@langchain/langgraph-sdk';
import { useState, useEffect, useRef, useCallback, useMemo, useReducer } from 'react';

import { WelcomeScreen } from '@/components/WelcomeScreen';
import { ChatMessagesView } from '@/components/ChatMessagesView';
import {
  extractAgentRuntimeEvents,
  extractClarificationInterruptId,
  extractTaskEventActiveRunHint,
  extractTaskEventGeneration,
  extractWeatherClarificationInterruptToolResult,
  isLangGraphInterruptEvent,
  runtimeEventToProcessedEvent,
} from '@/lib/agent-runtime-events';
import {
  createInteractionMetadataFetch,
  createInteractionRequestMetadata,
  withInteractionRequestMetadata,
} from '@/lib/interaction-request-metadata';
import type {
  InteractionActiveRunHint,
  InteractionInputKind,
} from '@/lib/interaction-request-metadata';
import { getAgentRunConfig } from '@/lib/agent-run-config';
import { FRONTEND_ERROR_MESSAGES } from '@/lib/error-messages';
import {
  createInitialStreamActivityState,
  streamActivityReducer,
} from '@/lib/stream-activity-state';
import type { StreamActivityState } from '@/lib/stream-activity-state';
import type { ProcessedImageAttachment } from '@/lib/image-upload';
import { AgentId, DEFAULT_AGENT } from '@/types/agents';
import {
  formatErrorEnvelope,
  parseErrorEnvelope,
  parseRateLimitError,
} from '@/types/errors';
import { getAgentById, isValidAgentId } from '@/lib/agents';
import {
  classifyStreamError,
  isStreamAbortError,
} from '@/lib/stream-error-classification';
import type { ClarificationResumeValue } from '@/components/WeatherToolResult';

const STREAM_ERROR_MESSAGE_ID = 'stream-error';
const WEATHER_CLARIFICATION_AI_MESSAGE_ID = 'weather-clarification-interrupt-ai';
const WEATHER_CLARIFICATION_TOOL_MESSAGE_ID = 'weather-clarification-interrupt-tool';

function formatStreamError(error: unknown): string {
  const envelope =
    parseErrorEnvelope(error) ||
    parseErrorEnvelope(error instanceof Error ? error.message : String(error));

  if (envelope) {
    return formatErrorEnvelope(envelope);
  }

  return [
    `${FRONTEND_ERROR_MESSAGES.errorEnvelope.source}: ${FRONTEND_ERROR_MESSAGES.stream.source}`,
    `${FRONTEND_ERROR_MESSAGES.errorEnvelope.stage}: ${FRONTEND_ERROR_MESSAGES.stream.stage}`,
    `${FRONTEND_ERROR_MESSAGES.errorEnvelope.code}: ${FRONTEND_ERROR_MESSAGES.stream.unknownCode}`,
    `${FRONTEND_ERROR_MESSAGES.errorEnvelope.message}: ${
      error instanceof Error ? error.message : String(error)
    }`,
  ].join('\n');
}

function formatRateLimitMessage(retryAfter: number): string {
  const messages = FRONTEND_ERROR_MESSAGES.rateLimit;
  return `${messages.title}，${messages.message(retryAfter)}`;
}

function getLangGraphApiUrl(): string {
  const configuredUrl = import.meta.env.VITE_LANGGRAPH_API_URL;
  if (configuredUrl) return configuredUrl;

  return new URL('/api/langgraph', window.location.origin).toString();
}

function createCancelledAssistantMessage(): Message {
  return {
    type: 'ai',
    content: '已取消本次回覆。',
    id: `local-cancelled-${crypto.randomUUID()}`,
  } as Message;
}

function isTerminalStreamLifecycle(
  lifecycle: StreamActivityState['lifecycle']
): boolean {
  return lifecycle === 'finished' || lifecycle === 'error' || lifecycle === 'cancelled';
}

function findArchiveMessageId(
  messages: Message[],
  startIndex: number,
  excludeMessageId?: string
): string | undefined {
  return messages.slice(startIndex).find((message) => {
    return message.type === 'ai' && message.id && message.id !== excludeMessageId;
  })?.id;
}

function getCurrentFinalAssistantMessageId(messages: Message[]): string | undefined {
  const lastMessage = messages[messages.length - 1];
  return lastMessage?.type === 'ai' ? lastMessage.id : undefined;
}

function createWeatherClarificationDisplayMessages(
  toolResult: NonNullable<ReturnType<typeof extractWeatherClarificationInterruptToolResult>>
): Message[] {
  return [
    {
      type: 'ai',
      content: '',
      id: WEATHER_CLARIFICATION_AI_MESSAGE_ID,
      tool_calls: [
        {
          id: toolResult.toolCallId,
          name: toolResult.toolName,
          args: {},
          type: 'tool_call',
        },
      ],
    },
    {
      type: 'tool',
      content: toolResult.content,
      id: WEATHER_CLARIFICATION_TOOL_MESSAGE_ID,
      tool_call_id: toolResult.toolCallId,
      name: toolResult.toolName,
    },
  ] as Message[];
}

export default function App() {
  const [streamActivityState, dispatchStreamActivity] = useReducer(
    streamActivityReducer,
    undefined,
    createInitialStreamActivityState
  );
  const [selectedAgentId, setSelectedAgentId] = useState(DEFAULT_AGENT);
  const [streamErrorMessage, setStreamErrorMessage] = useState<string | null>(null);
  const [rateLimitRetryAfter, setRateLimitRetryAfter] = useState<number | null>(null);
  const [cancelledMessage, setCancelledMessage] = useState<Message | null>(null);
  const [weatherClarificationMessages, setWeatherClarificationMessages] =
    useState<Message[] | null>(null);
  const [isDispatching, setIsDispatching] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const selectedAgentIdRef = useRef(selectedAgentId);
  const messagesRef = useRef<Message[]>([]);
  const streamActivityStateRef = useRef(streamActivityState);
  const clarificationResumePendingRef = useRef(false);
  const clarificationInterruptIdRef = useRef<string | undefined>(undefined);
  const dispatchingRef = useRef(false);
  const activeRunHintRef = useRef<InteractionActiveRunHint | undefined>(undefined);
  const interactionMetadataFetch = useMemo(
    () => createInteractionMetadataFetch(),
    []
  );

  const releaseDispatch = useCallback(() => {
    dispatchingRef.current = false;
    setIsDispatching(false);
  }, []);

  const beginDispatch = useCallback((): boolean => {
    if (dispatchingRef.current) return false;
    dispatchingRef.current = true;
    setIsDispatching(true);
    return true;
  }, []);

  useEffect(() => {
    selectedAgentIdRef.current = selectedAgentId;
  }, [selectedAgentId]);

  useEffect(() => {
    streamActivityStateRef.current = streamActivityState;
  }, [streamActivityState]);

  const isRateLimited = rateLimitRetryAfter !== null;

  useEffect(() => {
    if (!isRateLimited) return;

    const interval = window.setInterval(() => {
      setRateLimitRetryAfter((current) => {
        if (current === null || current <= 1) return null;
        return current - 1;
      });
    }, 1_000);

    return () => window.clearInterval(interval);
  }, [isRateLimited]);

  const validateAgentId = useCallback((agentId: string): string => {
    if (isValidAgentId(agentId)) {
      return agentId;
    }
    console.warn(`Invalid agent ID: ${agentId}, falling back to default`);
    return DEFAULT_AGENT;
  }, []);

  const handleAgentSwitch = useCallback(
    (newAgentId: string) => {
      const validAgentId = validateAgentId(newAgentId);
      if (validAgentId !== selectedAgentId) {
        setSelectedAgentId(validAgentId as AgentId);
        dispatchStreamActivity({
          type: 'resetForAgentOrSubmit',
          clearHistorical: true,
        });
        setCancelledMessage(null);
        setWeatherClarificationMessages(null);
        clarificationResumePendingRef.current = false;
        clarificationInterruptIdRef.current = undefined;
        releaseDispatch();
        activeRunHintRef.current = undefined;
      }
    },
    [releaseDispatch, selectedAgentId, validateAgentId]
  );

  const handleAgentChange = useCallback(
    (agentId: string) => {
      const validAgentId = validateAgentId(agentId);
      setSelectedAgentId(validAgentId as AgentId);
    },
    [validateAgentId]
  );

  const handleStreamError = useCallback((error: unknown) => {
    releaseDispatch();
    if (clarificationResumePendingRef.current) {
      setWeatherClarificationMessages(null);
    }
    clarificationResumePendingRef.current = false;
    // Best-effort fast path; reducer terminal idempotency is the primary guard.
    if (
      isStreamAbortError(error) &&
      streamActivityStateRef.current.lifecycle === 'cancelled'
    ) {
      console.debug('Stream aborted by client action.');
      return;
    }
    const rateLimitError = parseRateLimitError(error);
    const message = rateLimitError
      ? formatRateLimitMessage(rateLimitError.retryAfter)
      : formatStreamError(error);
    if (rateLimitError) {
      setRateLimitRetryAfter(rateLimitError.retryAfter);
      setStreamErrorMessage(null);
    } else {
      setRateLimitRetryAfter(null);
      setStreamErrorMessage(message);
    }
    dispatchStreamActivity({
      type: 'streamFailed',
      errorKind: classifyStreamError(error),
      message,
      messagesLengthAtTerminal: messagesRef.current.length,
      archiveMessageId: STREAM_ERROR_MESSAGE_ID,
    });
    console.error('LangGraph stream error:', error);
  }, [releaseDispatch]);

  const handleStreamFinish = useCallback((event: unknown) => {
    void event;
    releaseDispatch();
    if (clarificationResumePendingRef.current) {
      setWeatherClarificationMessages(null);
    }
    clarificationResumePendingRef.current = false;
    dispatchStreamActivity({
      type: 'streamFinished',
      messagesLengthAtTerminal: messagesRef.current.length,
      archiveMessageId: getCurrentFinalAssistantMessageId(messagesRef.current),
    });
  }, [releaseDispatch]);

  const handleStreamUpdate = useCallback((event: Record<string, unknown>) => {
    releaseDispatch();
    const activeRunHint = extractTaskEventActiveRunHint(event);
    if (
      activeRunHint &&
      (!activeRunHintRef.current ||
        activeRunHint.generation >= activeRunHintRef.current.generation)
    ) {
      activeRunHintRef.current = activeRunHint;
    }

    const isInterruptEvent = isLangGraphInterruptEvent(event);
    if (isInterruptEvent) {
      clarificationResumePendingRef.current = false;
      clarificationInterruptIdRef.current =
        extractClarificationInterruptId(event);
      const toolResult = extractWeatherClarificationInterruptToolResult(event);
      if (toolResult) {
        setWeatherClarificationMessages(
          createWeatherClarificationDisplayMessages(toolResult)
        );
      }
      dispatchStreamActivity({
        type: 'streamFinished',
        messagesLengthAtTerminal: messagesRef.current.length,
        archiveMessageId: getCurrentFinalAssistantMessageId(messagesRef.current),
      });
    } else if (clarificationResumePendingRef.current) {
      clarificationResumePendingRef.current = false;
      setWeatherClarificationMessages(null);
    }

    const currentAgent = getAgentById(selectedAgentIdRef.current);
    if (!currentAgent?.showActivityTimeline) return;

    const processedEvents = extractAgentRuntimeEvents(event).map(
      runtimeEventToProcessedEvent
    );

    if (processedEvents.length > 0) {
      dispatchStreamActivity({
        type: 'streamEventsReceived',
        events: processedEvents,
        generation: extractTaskEventGeneration(event),
      });
    }
  }, [releaseDispatch]);

  const thread = useStream<{
    messages: Message[];
    kind?: InteractionInputKind;
    targetRunId?: string;
    initial_search_query_count: number;
    max_research_loops: number;
    reasoning_model: string;
  }>({
    apiUrl: getLangGraphApiUrl(),
    assistantId: selectedAgentId,
    messagesKey: 'messages',
    onError: handleStreamError,
    onFinish: handleStreamFinish,
    onUpdateEvent: handleStreamUpdate,
    callerOptions: { fetch: interactionMetadataFetch },
  });

  useEffect(() => {
    messagesRef.current = thread.messages;
  }, [thread.messages]);

  useEffect(() => {
    const pendingArchive = streamActivityState.pendingArchive;
    if (!pendingArchive) return;

    const archiveMessageId = findArchiveMessageId(
      thread.messages,
      pendingArchive.messagesLengthAtTerminal,
      pendingArchive.excludeMessageId
    );

    if (!archiveMessageId) return;

    dispatchStreamActivity({
      type: 'archiveLiveActivity',
      messageId: archiveMessageId,
    });
  }, [streamActivityState.pendingArchive, thread.messages]);

  const handleSubmit = useCallback(
    (
      submittedInputValue: string,
      effort: string,
      model: string,
      agentId: string,
      attachments: ProcessedImageAttachment[]
    ) => {
      if (weatherClarificationMessages || rateLimitRetryAfter !== null) return;

      const validAgentId = validateAgentId(agentId);
      if (!submittedInputValue.trim() && attachments.length === 0) return;
      if (!beginDispatch()) return;

      handleAgentSwitch(validAgentId);
      dispatchStreamActivity({ type: 'resetForAgentOrSubmit' });
      dispatchStreamActivity({ type: 'streamStarted' });
      setStreamErrorMessage(null);
      setRateLimitRetryAfter(null);
      setCancelledMessage(null);
      setWeatherClarificationMessages(null);

      const messageContent: Message['content'] =
        attachments.length > 0
          ? [
              ...(submittedInputValue.trim()
                ? [{ type: 'text' as const, text: submittedInputValue.trim() }]
                : [{ type: 'text' as const, text: 'Analyze the uploaded image attachments.' }]),
              ...attachments.map((attachment) => ({
                type: 'image_url' as const,
                image_url: {
                  url: attachment.dataUrl,
                  detail: 'auto' as const,
                },
                fileName: attachment.fileName,
                mimeType: attachment.mimeType,
                sizeBytes: attachment.processedBytes,
                width: attachment.width,
                height: attachment.height,
              })),
            ]
          : submittedInputValue;

      const newMessages: Message[] = [
        {
          type: 'human',
          content: messageContent,
          id: crypto.randomUUID(),
        },
      ];
      const submitOptions = withInteractionRequestMetadata(
        {},
        createInteractionRequestMetadata(
          activeRunHintRef.current,
          undefined,
          { inputKind: 'prompt' }
        )
      );

      try {
        if (validAgentId === AgentId.DEEP_RESEARCHER) {
          const runConfig = getAgentRunConfig(validAgentId, effort);

          thread.submit(
            {
              kind: 'prompt',
              messages: newMessages,
              ...runConfig,
              reasoning_model: model,
            },
            submitOptions
          );
        } else {
          thread.submit({ kind: 'prompt', messages: newMessages }, submitOptions);
        }
      } catch (error) {
        releaseDispatch();
        throw error;
      }
    },
    [
      validateAgentId,
      beginDispatch,
      handleAgentSwitch,
      rateLimitRetryAfter,
      thread,
      weatherClarificationMessages,
      releaseDispatch,
    ]
  );

  const handleClarificationResume = useCallback(
    (resumeValue: ClarificationResumeValue) => {
      if (rateLimitRetryAfter !== null) return;
      const interruptId = clarificationInterruptIdRef.current;
      if (!interruptId || !beginDispatch()) return;
      dispatchStreamActivity({ type: 'resetForAgentOrSubmit' });
      dispatchStreamActivity({ type: 'streamStarted' });
      setStreamErrorMessage(null);
      setRateLimitRetryAfter(null);
      setCancelledMessage(null);
      clarificationResumePendingRef.current = true;

      try {
        thread.submit(
          null,
          withInteractionRequestMetadata(
            { command: { resume: resumeValue } },
            createInteractionRequestMetadata(
              activeRunHintRef.current,
              undefined,
              { inputKind: 'clarification_resume', interruptId }
            )
          )
        );
      } catch (error) {
        releaseDispatch();
        throw error;
      }
    },
    [beginDispatch, rateLimitRetryAfter, releaseDispatch, thread]
  );

  const handleCancel = useCallback(() => {
    releaseDispatch();
    clarificationResumePendingRef.current = false;
    clarificationInterruptIdRef.current = undefined;
    setWeatherClarificationMessages(null);
    const localCancelledMessage = createCancelledAssistantMessage();
    dispatchStreamActivity({
      type: 'streamCancelled',
      messagesLengthAtTerminal: messagesRef.current.length,
      archiveMessageId: localCancelledMessage.id,
    });
    thread.stop();
    const activeRunHint = activeRunHintRef.current;
    thread.submit(
      {
        kind: 'cancel',
        ...(activeRunHint ? { targetRunId: activeRunHint.runId } : {}),
      },
      withInteractionRequestMetadata(
        {},
        createInteractionRequestMetadata(activeRunHint, undefined, {
          inputKind: 'cancel',
        })
      )
    );
    setCancelledMessage(localCancelledMessage);
  }, [releaseDispatch, thread]);

  const activeStreamErrorMessage =
    rateLimitRetryAfter === null
      ? streamErrorMessage
      : formatRateLimitMessage(rateLimitRetryAfter);
  const messagesWithStreamError = useMemo(
    () =>
      activeStreamErrorMessage
        ? [
            ...thread.messages,
            {
              type: 'ai',
              content: activeStreamErrorMessage,
              id: STREAM_ERROR_MESSAGE_ID,
            } as Message,
          ]
        : thread.messages,
    [activeStreamErrorMessage, thread.messages]
  );
  const messagesWithWeatherClarification = useMemo(
    () =>
      weatherClarificationMessages
        ? [...messagesWithStreamError, ...weatherClarificationMessages]
        : messagesWithStreamError,
    [messagesWithStreamError, weatherClarificationMessages]
  );
  const displayMessages = useMemo(
    () =>
      cancelledMessage
        ? [...messagesWithWeatherClarification, cancelledMessage]
        : messagesWithWeatherClarification,
    [messagesWithWeatherClarification, cancelledMessage]
  );
  const isChatLoading =
    (thread.isLoading || isDispatching) &&
    (!weatherClarificationMessages || clarificationResumePendingRef.current);

  useEffect(() => {
    if (scrollAreaRef.current) {
      const scrollViewport = scrollAreaRef.current.querySelector(
        '[data-radix-scroll-area-viewport]'
      );
      if (scrollViewport) {
        scrollViewport.scrollTop = scrollViewport.scrollHeight;
      }
    }
  }, [displayMessages.length]);

  return (
    <div className="flex h-screen bg-background text-foreground font-sans antialiased">
      <main className="flex-1 flex flex-col max-w-4xl mx-auto w-full min-h-0">
        <div
          className={`flex-1 min-h-0 ${
            displayMessages.length === 0 ? 'flex' : ''
          }`}
        >
          {displayMessages.length === 0 ? (
            <WelcomeScreen
              handleSubmit={handleSubmit}
              isLoading={thread.isLoading || isDispatching}
              onCancel={handleCancel}
              selectedAgent={selectedAgentId}
              onAgentChange={handleAgentChange}
            />
          ) : (
            <ChatMessagesView
              messages={displayMessages}
              isLoading={isChatLoading}
              scrollAreaRef={scrollAreaRef}
              onSubmit={handleSubmit}
              onCancel={handleCancel}
              liveActivityEvents={
                isTerminalStreamLifecycle(streamActivityState.lifecycle)
                  ? []
                  : streamActivityState.liveActivityEvents
              }
              historicalActivities={streamActivityState.historicalActivities}
              selectedAgentId={selectedAgentId}
              onAgentChange={handleAgentChange}
              onClarificationResume={handleClarificationResume}
            />
          )}
        </div>
      </main>
    </div>
  );
}
