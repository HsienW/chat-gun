import { useStream } from '@langchain/langgraph-sdk/react';
import type { Message } from '@langchain/langgraph-sdk';
import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  useReducer,
  type Dispatch,
  type SetStateAction,
} from 'react';

import { House } from 'lucide-react';

import { WelcomeScreen } from '@/components/WelcomeScreen';
import { ChatMessagesView } from '@/components/ChatMessagesView';
import { ChatSettings } from '@/components/ChatSettings';
import { HomeScreen } from '@/components/HomeScreen';
import { LeaveConfirmDialog } from '@/components/LeaveConfirmDialog';
import { ModeSwitcher } from '@/components/ModeSwitcher';
import {
  getEntryDefinition,
  resolveEntryAssistant,
  type EntryId,
  type EntryState,
} from '@/lib/entries';
import {
  extractAgentRuntimeEvents,
  extractClarificationInterruptId,
  extractTaskEventActiveRunHint,
  extractTaskEventGeneration,
  extractWeatherClarificationInterruptToolResult,
  isLangGraphInterruptEvent,
  runtimeEnvelopeToAgentRuntimeEvent,
  runtimeEventToProcessedEvent,
  runtimeParseFailureToAgentRuntimeEvent,
} from '@/lib/agent-runtime-events';
import { extractIncomingRuntimeEventResults } from '@/lib/legacy-event-adapter';
import { BoundedRuntimeEventBuffer } from '@/lib/runtime-event-envelope';
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
import { AgentId } from '@/types/agents';
import {
  formatErrorEnvelope,
  parseErrorEnvelope,
  parseRateLimitError,
} from '@/types/errors';
import { getAgentById } from '@/lib/agents';
import {
  classifyStreamError,
  isStreamAbortError,
} from '@/lib/stream-error-classification';
import type { ClarificationResumeValue } from '@/components/WeatherToolResult';
import {
  parseIdentityFailure,
  type IdentityFailure,
} from '@/lib/identity-lifecycle';
import { CommercePanel } from '@/components/commerce/CommercePanel';
import {
  createToolConfirmationResume,
  parseCommerceCard,
  parseOperationSnapshot,
  parseToolConfirmationInterrupt,
  type ToolConfirmationDecision,
  type ToolConfirmationRequest,
} from '@/lib/commerce-cards';
import type {
  ConfirmationSubmission,
  ConfirmationSubmitError,
} from '@/lib/commerce-labels';
import {
  commerceReducer,
  createInitialCommerceState,
  type TrackedOperation,
} from '@/lib/commerce-state';

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

function toConfirmationSubmitError(error: unknown): ConfirmationSubmitError {
  const envelope =
    parseErrorEnvelope(error) ||
    parseErrorEnvelope(error instanceof Error ? error.message : String(error));
  return {
    kind: classifyStreamError(error),
    ...(envelope ? { code: envelope.error.code } : {}),
  };
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

const WORKSPACE_LABELS = {
  home: '回首頁',
  homeLockedHint: '回覆進行中或審批送出中無法離開，請先取消',
} as const;

/** Session-wide state that survives entry switches (spec: rate limit and identity). */
interface SessionGuards {
  rateLimitRetryAfter: number | null;
  setRateLimitRetryAfter: Dispatch<SetStateAction<number | null>>;
  setIdentityFailure: (failure: IdentityFailure | undefined) => void;
}

interface ChatWorkspaceProps extends SessionGuards {
  entry: EntryId;
  /** `next === entry` starts a new session in the same entry. */
  onNavigate: (next: EntryState) => void;
}

export default function App() {
  const [entry, setEntry] = useState<EntryState>('home');
  const [sessionKey, setSessionKey] = useState(0);
  const [rateLimitRetryAfter, setRateLimitRetryAfter] = useState<number | null>(null);
  const [identityFailure, setIdentityFailure] = useState<IdentityFailure | undefined>();

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

  // Every entry visit is a new session: remounting resets the stream, thread and
  // all workspace state through one path (design D3/D9).
  const navigate = useCallback((next: EntryState) => {
    setEntry(next);
    if (next !== 'home') setSessionKey((key) => key + 1);
  }, []);

  return (
    <div className="flex h-screen bg-background text-foreground font-sans antialiased">
      <main className="flex-1 flex flex-col max-w-4xl mx-auto w-full min-h-0 pb-16">
        <ChatSettings
          identityFailure={identityFailure}
          accountStatus={identityFailure?.code === 'IDENTITY_ACCOUNT_SUSPENDED'
            ? 'suspended'
            : identityFailure?.code === 'IDENTITY_DELETION_PENDING'
              ? 'deletion_pending'
              : undefined}
          sessionStatus={identityFailure?.code === 'IDENTITY_SESSION_EXPIRED'
            ? 'expired'
            : identityFailure?.code === 'IDENTITY_REVOKED_CREDENTIAL'
              ? 'revoked'
              : undefined}
        />
        {entry === 'home' ? (
          <HomeScreen onSelectEntry={navigate} />
        ) : (
          <ChatWorkspace
            key={sessionKey}
            entry={entry}
            onNavigate={navigate}
            rateLimitRetryAfter={rateLimitRetryAfter}
            setRateLimitRetryAfter={setRateLimitRetryAfter}
            setIdentityFailure={setIdentityFailure}
          />
        )}
      </main>
    </div>
  );
}

function ChatWorkspace({
  entry,
  onNavigate,
  rateLimitRetryAfter,
  setRateLimitRetryAfter,
  setIdentityFailure,
}: ChatWorkspaceProps) {
  const [streamActivityState, dispatchStreamActivity] = useReducer(
    streamActivityReducer,
    undefined,
    createInitialStreamActivityState
  );
  const [deepResearchEnabled, setDeepResearchEnabled] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<EntryState | null>(null);
  const [streamErrorMessage, setStreamErrorMessage] = useState<string | null>(null);
  const [cancelledMessage, setCancelledMessage] = useState<Message | null>(null);
  const [weatherClarificationMessages, setWeatherClarificationMessages] =
    useState<Message[] | null>(null);
  const [isDispatching, setIsDispatching] = useState(false);
  const [commerceState, dispatchCommerce] = useReducer(
    commerceReducer,
    undefined,
    createInitialCommerceState
  );
  const [confirmationSubmission, setConfirmationSubmission] = useState<
    ConfirmationSubmission | undefined
  >();
  const [lastConfirmationRequest, setLastConfirmationRequest] = useState<
    ToolConfirmationRequest | undefined
  >();
  const confirmationSubmissionRef = useRef<ConfirmationSubmission | undefined>(undefined);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const targetAgentId = resolveEntryAssistant(entry, deepResearchEnabled);
  const targetAgentIdRef = useRef(targetAgentId);
  const messagesRef = useRef<Message[]>([]);
  const streamActivityStateRef = useRef(streamActivityState);
  const clarificationResumePendingRef = useRef(false);
  const clarificationInterruptIdRef = useRef<string | undefined>(undefined);
  const dispatchingRef = useRef(false);
  const activeRunHintRef = useRef<InteractionActiveRunHint | undefined>(undefined);
  const runtimeEventBufferRef = useRef(new BoundedRuntimeEventBuffer());
  const interactionMetadataFetch = useMemo(
    () => createInteractionMetadataFetch(),
    []
  );

  const releaseDispatch = useCallback(() => {
    dispatchingRef.current = false;
    setIsDispatching(false);
  }, []);

  const updateConfirmationSubmission = useCallback(
    (submission: ConfirmationSubmission | undefined) => {
      confirmationSubmissionRef.current = submission;
      setConfirmationSubmission(submission);
    },
    []
  );

  const beginDispatch = useCallback((): boolean => {
    if (dispatchingRef.current) return false;
    dispatchingRef.current = true;
    setIsDispatching(true);
    return true;
  }, []);

  useEffect(() => {
    targetAgentIdRef.current = targetAgentId;
  }, [targetAgentId]);

  useEffect(() => {
    streamActivityStateRef.current = streamActivityState;
  }, [streamActivityState]);

  const handleStreamError = useCallback((error: unknown) => {
    releaseDispatch();
    const submission = confirmationSubmissionRef.current;
    if (submission?.status === 'submitting') {
      // The decision is not assumed to have taken effect; the card stays open.
      updateConfirmationSubmission({
        approvalId: submission.approvalId,
        status: 'failed',
        error: toConfirmationSubmitError(error),
      });
    }
    if (clarificationResumePendingRef.current) {
      setWeatherClarificationMessages(null);
    }
    clarificationResumePendingRef.current = false;
    setIdentityFailure(parseIdentityFailure(error));
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
  }, [releaseDispatch, setIdentityFailure, setRateLimitRetryAfter, updateConfirmationSubmission]);

  const handleStreamFinish = useCallback((event: unknown) => {
    void event;
    releaseDispatch();
    // From here the server thread state decides what the operation shows.
    if (confirmationSubmissionRef.current?.status === 'submitting') {
      updateConfirmationSubmission(undefined);
    }
    if (clarificationResumePendingRef.current) {
      setWeatherClarificationMessages(null);
    }
    clarificationResumePendingRef.current = false;
    dispatchStreamActivity({
      type: 'streamFinished',
      messagesLengthAtTerminal: messagesRef.current.length,
      archiveMessageId: getCurrentFinalAssistantMessageId(messagesRef.current),
    });
  }, [releaseDispatch, updateConfirmationSubmission]);

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

    const currentAgent = getAgentById(targetAgentIdRef.current);
    if (!currentAgent?.showActivityTimeline) return;

    const versionedEvents = extractIncomingRuntimeEventResults(event).flatMap(
      (result) => {
        if (result.kind === 'legacy') return [];
        if (result.kind === 'unknown') {
          console.info({
            code: 'events.parse.degraded',
            reason: result.reason,
            ...(result.originalType ? { originalType: result.originalType } : {}),
          });
          return [runtimeParseFailureToAgentRuntimeEvent(result)];
        }
        const authoritativeRun = activeRunHintRef.current?.runId;
        if (
          authoritativeRun &&
          result.envelope.context.runId !== authoritativeRun
        ) {
          console.info({
            code: 'events.run.stale',
            runId: result.envelope.context.runId,
            authoritativeRunId: authoritativeRun,
          });
          return [];
        }
        const buffered = runtimeEventBufferRef.current.push(result.envelope);
        buffered.observations.forEach((observation) => console.info(observation));
        return buffered.events.map(runtimeEnvelopeToAgentRuntimeEvent);
      }
    );
    const runtimeEvents = [...extractAgentRuntimeEvents(event), ...versionedEvents];
    const cards = runtimeEvents.flatMap((runtimeEvent) =>
      runtimeEvent.type === 'agent.card.emit'
        ? [
            {
              card: parseCommerceCard(runtimeEvent.cardType, runtimeEvent.payload),
              runId: runtimeEvent.correlation?.runId,
            },
          ]
        : []
    );
    if (cards.length > 0) {
      dispatchCommerce({ type: 'cardsReceived', cards });
    }
    const processedEvents = runtimeEvents.map(runtimeEventToProcessedEvent);

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
    assistantId: targetAgentId,
    messagesKey: 'messages',
    onError: handleStreamError,
    onFinish: handleStreamFinish,
    onUpdateEvent: handleStreamUpdate,
    callerOptions: { fetch: interactionMetadataFetch },
  });

  useEffect(() => {
    messagesRef.current = thread.messages;
  }, [thread.messages]);

  // The server thread state is authoritative, including after a reload.
  const threadHeadValues = thread.history?.at(-1)?.values;
  useEffect(() => {
    const operations = parseOperationSnapshot(threadHeadValues);
    if (operations.length > 0) {
      dispatchCommerce({ type: 'snapshotReceived', operations });
    }
  }, [threadHeadValues]);

  const serverConfirmationRequest = useMemo(
    () => parseToolConfirmationInterrupt(thread.interrupt?.value),
    [thread.interrupt]
  );
  useEffect(() => {
    if (serverConfirmationRequest) setLastConfirmationRequest(serverConfirmationRequest);
  }, [serverConfirmationRequest]);
  // The interrupt is hidden while a run streams; keep the last one so the card
  // stays in place. It only renders for an operation still awaiting approval.
  const confirmationRequest = serverConfirmationRequest ?? lastConfirmationRequest;

  const handleConfirmationDecision = useCallback(
    (request: ToolConfirmationRequest, decision: ToolConfirmationDecision) => {
      if (rateLimitRetryAfter !== null) return;
      if (!beginDispatch()) return;
      dispatchStreamActivity({ type: 'resetForAgentOrSubmit' });
      dispatchStreamActivity({ type: 'streamStarted' });
      setStreamErrorMessage(null);
      setCancelledMessage(null);
      updateConfirmationSubmission({ approvalId: request.approvalId, status: 'submitting' });

      try {
        thread.submit(
          null,
          withInteractionRequestMetadata(
            { command: { resume: createToolConfirmationResume(request, decision) } },
            createInteractionRequestMetadata(activeRunHintRef.current)
          )
        );
      } catch (error) {
        releaseDispatch();
        updateConfirmationSubmission({
          approvalId: request.approvalId,
          status: 'failed',
          error: toConfirmationSubmitError(error),
        });
      }
    },
    [beginDispatch, rateLimitRetryAfter, releaseDispatch, thread, updateConfirmationSubmission]
  );

  const handleConfirmationCancel = useCallback(
    (operation: TrackedOperation) => {
      if (rateLimitRetryAfter !== null) return;
      const approvalId = operation.card.operationRef.operationId;
      if (!approvalId || !beginDispatch()) return;
      dispatchStreamActivity({ type: 'resetForAgentOrSubmit' });
      dispatchStreamActivity({ type: 'streamStarted' });
      setStreamErrorMessage(null);
      setCancelledMessage(null);
      updateConfirmationSubmission({ approvalId, status: 'submitting' });

      try {
        // The backend withdraws by its checkpoint; targetRunId is only compared (design §6.2).
        thread.submit(
          {
            kind: 'cancel',
            ...(operation.approvalRunId ? { targetRunId: operation.approvalRunId } : {}),
          },
          withInteractionRequestMetadata(
            {},
            createInteractionRequestMetadata(activeRunHintRef.current, undefined, {
              inputKind: 'cancel',
            })
          )
        );
      } catch (error) {
        releaseDispatch();
        updateConfirmationSubmission({
          approvalId,
          status: 'failed',
          error: toConfirmationSubmitError(error),
        });
      }
    },
    [beginDispatch, rateLimitRetryAfter, releaseDispatch, thread, updateConfirmationSubmission]
  );

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
      attachments: ProcessedImageAttachment[]
    ) => {
      if (weatherClarificationMessages || rateLimitRetryAfter !== null) return;

      if (!submittedInputValue.trim() && attachments.length === 0) return;
      if (!beginDispatch()) return;

      // Toggling deep research only changes the target; it never resets the
      // workspace, so archived activity and the thread stay (design D4).
      dispatchStreamActivity({ type: 'resetForAgentOrSubmit' });
      dispatchStreamActivity({ type: 'streamStarted' });
      dispatchCommerce({ type: 'turnStarted' });
      setStreamErrorMessage(null);
      setRateLimitRetryAfter(null);
      setCancelledMessage(null);
      setIdentityFailure(undefined);
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
        if (targetAgentId === AgentId.DEEP_RESEARCHER) {
          const runConfig = getAgentRunConfig(targetAgentId, effort);

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
      beginDispatch,
      rateLimitRetryAfter,
      setIdentityFailure,
      setRateLimitRetryAfter,
      targetAgentId,
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
    [beginDispatch, rateLimitRetryAfter, releaseDispatch, setRateLimitRetryAfter, thread]
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

  const entryDefinition = getEntryDefinition(entry);
  const isRunActive =
    thread.isLoading || isDispatching || confirmationSubmission?.status === 'submitting';
  const isAwaitingClarification = weatherClarificationMessages !== null;
  // A waiting or failed approval keeps its card open until the server decides.
  const hasPendingApproval = Object.values(commerceState.operations).some(
    ({ card }) => card.state.known && card.state.value === 'awaiting_approval'
  );

  const requestNavigation = useCallback(
    (next: EntryState) => {
      if (isRunActive) return;
      if (hasPendingApproval) {
        setPendingNavigation(next);
        return;
      }
      onNavigate(next);
    },
    [hasPendingApproval, isRunActive, onNavigate]
  );
  const confirmNavigation = useCallback(() => {
    if (pendingNavigation === null) return;
    onNavigate(pendingNavigation);
  }, [onNavigate, pendingNavigation]);
  const cancelNavigation = useCallback(() => setPendingNavigation(null), []);
  const startNewConversation = useCallback(
    () => requestNavigation(entry),
    [entry, requestNavigation]
  );

  const deepResearch = entryDefinition.supportsDeepResearch
    ? {
        enabled: deepResearchEnabled,
        locked: isRunActive || isAwaitingClarification,
        onChange: setDeepResearchEnabled,
      }
    : undefined;

  return (
    <>
      <div className="fixed top-4 left-4 z-50 flex items-center gap-2">
        <ModeSwitcher current={entry} locked={isRunActive} onSelect={requestNavigation} />
        <button
          type="button"
          disabled={isRunActive}
          title={isRunActive ? WORKSPACE_LABELS.homeLockedHint : undefined}
          aria-label={WORKSPACE_LABELS.home}
          onClick={() => requestNavigation('home')}
          className="rounded-lg p-2 text-[#E7D9C1] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
        >
          <House className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      {pendingNavigation !== null && (
        <LeaveConfirmDialog onConfirm={confirmNavigation} onCancel={cancelNavigation} />
      )}
      <div
        className={`flex-1 min-h-0 ${
          displayMessages.length === 0 ? 'flex' : ''
        }`}
      >
        {displayMessages.length === 0 ? (
          <WelcomeScreen
            entry={entryDefinition}
            handleSubmit={handleSubmit}
            isLoading={thread.isLoading || isDispatching}
            onCancel={handleCancel}
            targetAgentId={targetAgentId}
            deepResearch={deepResearch}
            onNewConversation={startNewConversation}
            newConversationDisabled={isRunActive}
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
            targetAgentId={targetAgentId}
            deepResearch={deepResearch}
            onNewConversation={startNewConversation}
            newConversationDisabled={isRunActive}
            onClarificationResume={handleClarificationResume}
            commercePanel={
              <CommercePanel
                state={commerceState}
                confirmationRequest={confirmationRequest}
                submission={confirmationSubmission}
                onDecision={handleConfirmationDecision}
                onCancelRequest={handleConfirmationCancel}
              />
            }
          />
        )}
      </div>
    </>
  );
}
