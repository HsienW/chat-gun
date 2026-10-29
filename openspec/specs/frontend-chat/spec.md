# frontend-chat Specification

## Purpose
TBD - created by archiving change frontend-react-performance-alignment. Update Purpose after archive.
## Requirements
### Requirement: Chat message rendering MUST avoid unnecessary recomputation

Frontend MUST avoid recomputing grouped chat messages when the `messages` reference has not changed.

#### Scenario: Messages reference is unchanged

- GIVEN `ChatMessagesView` receives the same `messages` array reference across renders
- WHEN the parent component re-renders because unrelated state changed
- THEN `groupMessages(messages)` MUST NOT be recomputed for that render
- AND existing message order and grouping semantics MUST remain unchanged

#### Scenario: Messages reference changes

- GIVEN `ChatMessagesView` receives a new `messages` array reference
- WHEN the component renders
- THEN grouped messages MUST be recomputed from the new messages
- AND tool call grouping MUST remain compatible with the existing behavior

---

### Requirement: Derived display message arrays MUST preserve stable references

Frontend MUST memoize display-only derived message arrays so unrelated renders do not create new references.

#### Scenario: No stream error or cancellation state changes

- GIVEN `thread.messages`, `streamErrorMessage`, and `cancelledMessage` are unchanged
- WHEN `App` re-renders for unrelated state
- THEN `messagesWithStreamError` and `displayMessages` SHOULD keep stable references
- AND `ChatMessagesView` MUST receive the same display messages reference

#### Scenario: Stream error changes

- GIVEN `streamErrorMessage` changes
- WHEN `App` re-renders
- THEN `messagesWithStreamError` MUST be recomputed
- AND the stream error message MUST still be appended with the existing message shape and order

#### Scenario: Cancellation message changes

- GIVEN `cancelledMessage` changes
- WHEN `App` re-renders
- THEN `displayMessages` MUST be recomputed
- AND the cancelled assistant message MUST remain appended after stream error handling

---

### Requirement: Chat callbacks MUST be stable without stale state

Frontend MUST stabilize callbacks passed to memoized children or runtime hooks while preserving current state semantics.

#### Scenario: Copy callback is passed to AI bubbles

- GIVEN `ChatMessagesView` re-renders without changing copy-related dependencies
- WHEN `AiMessageBubble` receives `handleCopy`
- THEN `handleCopy` SHOULD keep a stable function reference
- AND copy-to-clipboard behavior MUST remain unchanged

#### Scenario: Runtime update callback reads the current target assistant

- GIVEN 目前目標 assistant 因入口或深度研究開關改變（目標 assistant 由入口與開關推導，不再由 agent 選單設定）
- WHEN a later stream update event is handled
- THEN `onUpdateEvent` MUST read the latest target assistant value
- AND the callback MUST NOT rely on a stale closure

#### Scenario: Hook dependency validation

- WHEN frontend lint runs
- THEN the new `useMemo` and `useCallback` usages MUST satisfy `react-hooks/exhaustive-deps`

### Requirement: Pure chat display components MUST define safe memo boundaries

Frontend MUST define safe memo boundaries around pure chat display components so unchanged historical bubbles can skip renders during unrelated parent renders.

#### Scenario: Human message bubble props are unchanged

- GIVEN a human message bubble receives unchanged props
- WHEN the parent chat view re-renders
- THEN the human bubble SHOULD skip rendering
- AND its Markdown and image attachment display MUST remain unchanged

#### Scenario: AI message bubble props are unchanged

- GIVEN an AI message bubble receives unchanged props
- WHEN the parent chat view re-renders
- THEN the AI bubble SHOULD skip rendering
- AND Activity Timeline, Tool Call display, Markdown, and Copy Button behavior MUST remain unchanged

#### Scenario: Tool display memo is applied from the consumer

- GIVEN `ChatMessagesView` renders `ToolMessageDisplay`
- WHEN memoization is added
- THEN the memo wrapper SHOULD be applied from `ChatMessagesView`
- AND `ToolMessageDisplay.tsx` MUST NOT be modified by this Change

---

### Requirement: Timer and upload queue async work MUST be unmount safe

Frontend MUST prevent known timer and upload queue async callbacks from updating state after component unmount.

#### Scenario: Copy reset timer is pending during unmount

- GIVEN a copy success reset timer is pending
- WHEN `ChatMessagesView` unmounts
- THEN the timer MUST be cleared
- AND React MUST NOT receive a state update from that timer after unmount

#### Scenario: A new copy action occurs before the previous timer fires

- GIVEN a copy reset timer is pending
- WHEN the user copies another message
- THEN the previous timer MUST be cleared before creating the new timer
- AND the visible copied state MUST still reset after the configured delay

#### Scenario: Upload queue resolves after unmount

- GIVEN `InputForm` has an upload queue async operation in flight
- WHEN `InputForm` unmounts before the operation settles
- THEN upload queue callbacks MUST NOT call state setters after unmount
- AND upload preflight, queue order, and error semantics MUST remain unchanged while mounted

---

### Requirement: Frontend performance alignment MUST preserve product contracts

This Change MUST NOT alter product behavior, UI appearance, public contracts, or cross-layer data shapes.

#### Scenario: Source execute is applied

- WHEN the implementation is complete
- THEN only `frontend/src/App.tsx`, `frontend/src/components/ChatMessagesView.tsx`, and `frontend/src/components/InputForm.tsx` SHOULD need source changes
- AND BFF and backend files MUST remain unchanged
- AND dependency manifests MUST remain unchanged

#### Scenario: Tool and stream behavior is exercised

- GIVEN a conversation includes stream updates and Tool Calls
- WHEN the frontend renders the conversation
- THEN Tool Result rendering MUST remain compatible with the previous behavior
- AND stream terminal state handling MUST remain unchanged
- AND no public event, schema, route, Graph ID, or request payload shape MUST change

#### Scenario: Performance verification is available

- GIVEN React DevTools Profiler can be used in the local environment
- WHEN the same 3-5 message scenario is recorded before and after implementation
- THEN unchanged historical bubbles SHOULD no longer re-render on every stream update
- AND total re-render count SHOULD be less than or equal to 70% of the baseline

### Requirement: Stream activity state 必須透過明確 lifecycle transitions 收斂

Frontend chat MUST 以明確 transitions 建模 stream activity lifecycle，並且必須避免 terminal activity state 回到 running。

#### Scenario: Stream starts and receives runtime events
- **WHEN** 新 chat run 開始且收到 runtime events
- **THEN** live activity state 必須進入 running
- **AND** 收到的 runtime events 必須依 arrival order append 到 live activity timeline

#### Scenario: Stream finishes successfully
- **WHEN** running chat stream 回報 successful completion
- **THEN** live activity state 必須進入 finished terminal state
- **AND** 後續重複的 finish notifications 不得重複 archived activity

#### Scenario: Stream fails with an error
- **WHEN** running chat stream 回報 non-cancel error
- **THEN** live activity state 必須進入 error terminal state
- **AND** late progress events 不得讓 state 回到 running

#### Scenario: Stream times out
- **WHEN** running chat stream 回報 timeout failure
- **THEN** live activity state 必須進入保留 timeout 語意的 error terminal state
- **AND** chat UI 不得將 timeout 視為 successful completion

#### Scenario: Stream is cancelled by the user
- **WHEN** 使用者取消 running chat stream
- **THEN** live activity state 必須進入 cancelled terminal state
- **AND** late progress events 不得讓 state 回到 running

#### Scenario: New run begins after terminal state
- **WHEN** finished、error 或 cancelled run 後開始 new chat run
- **THEN** previous live activity 必須為 new run reset
- **AND** previous assistant messages 的 archived activity 必須維持可用

---

### Requirement: Runtime event extraction 必須保留既有 event sources

Frontend chat MUST 從 direct stream payloads、nested node payloads 與 node adapter fallbacks 擷取 runtime events，且不得改變既有 known-event semantics。

#### Scenario: Direct runtime events are present
- **WHEN** stream update 包含 direct runtime events
- **THEN** 這些 events 必須被擷取為 runtime events
- **AND** 其 known event fields 必須保留以供 activity rendering

#### Scenario: Nested runtime events are present
- **WHEN** stream update 在 nested node values 內包含 runtime events
- **THEN** 這些 nested runtime events 必須被擷取
- **AND** extraction 不得需要 React component 或 stream hook mock

#### Scenario: Node adapter fallback is needed
- **WHEN** known node payload 不包含 direct runtime events
- **THEN** frontend chat 必須將 node payload adapt 成本 Change 前使用的 same known runtime event shapes

#### Scenario: Node already contains runtime events
- **WHEN** known node payload 已包含 runtime events
- **THEN** frontend chat 不得對同一個 node payload 額外套用 node adapter fallback

#### Scenario: Malformed event payload is received
- **WHEN** stream update 包含不是 valid runtime events 且無法 adapt 的 values
- **THEN** frontend chat 必須 skip 這些 malformed values
- **AND** chat UI 必須繼續 render 同一 update 中 remaining valid events

---

### Requirement: Unknown agent runtime events 必須安全降級

Frontend chat MUST 處理未來或未知的 `agent.*` runtime event types，不得崩潰，也不得回傳 undefined processed activity items。

#### Scenario: Unknown agent event is received
- **WHEN** runtime event 的 type 是以 `agent.` 開頭的 string，但不是 known event types 之一
- **THEN** frontend chat 必須將其轉換成 generic activity item
- **AND** generic item 必須保留 original event type 以利 troubleshooting

#### Scenario: Unknown event contains extra fields
- **WHEN** unknown agent event 包含 additional fields
- **THEN** frontend chat 必須保留這些 fields 的 safe serializable representation
- **AND** 不得執行或信任 event payload 內嵌的 markup、script 或 instructions

#### Scenario: Unknown non-agent event is received
- **WHEN** event-like value 未使用 `agent.` event type
- **THEN** frontend chat 必須 skip 該 value
- **AND** chat UI 必須繼續處理同一 update 中的 valid agent events

---

### Requirement: Activity archive 必須附著到正確 assistant message

當 stable message id 可用時，Frontend chat MUST 把 terminal live activity archive 到代表 completed、failed 或 cancelled run 的 assistant message。

#### Scenario: Final assistant message id is available at finish time
- **WHEN** running stream 完成，且 final assistant message id 可用
- **THEN** frontend chat 必須將 live activity archive 到該 assistant message id 底下
- **AND** archived activity 必須在該 message 後續以 historical chat render 時可用

#### Scenario: Final assistant message id becomes available after finish
- **WHEN** running stream 在 final assistant message id 可觀察前完成
- **THEN** frontend chat 必須保留 pending archive intent
- **AND** 一旦 stable assistant message id 可用，就必須 archive live activity

#### Scenario: Archive action is repeated
- **WHEN** 同一份 terminal activity 針對同一 assistant message id 被 archive 超過一次
- **THEN** frontend chat 必須保留第一次 archived activity
- **AND** 不得 duplicate activity entries

#### Scenario: Error message is represented locally
- **WHEN** stream error 以 local assistant message 呈現
- **THEN** frontend chat 可以將 terminal activity archive 到該 local assistant message id
- **AND** stream error message order 必須維持與既有 chat rendering 相容

#### Scenario: Cancelled message is represented locally
- **WHEN** user cancellation 以 local assistant message 呈現
- **THEN** frontend chat 可以將 terminal activity archive 到該 local assistant message id
- **AND** cancelled assistant message 必須在 loading stops 後維持可見

---

### Requirement: Stream state refactor 必須保留既有 frontend chat contracts

Frontend chat MUST 保留既有 public stream callback contracts、message rendering behavior、activity timeline rendering behavior 與 component-facing activity data compatibility。

#### Scenario: Runtime hook callbacks are registered
- **WHEN** frontend chat 設定 runtime stream callbacks
- **THEN** update、finish 與 error callback signatures 必須維持與 runtime hook 相容
- **AND** callbacks 不得要求 BFF 或 backend changes

#### Scenario: Existing parser exports are used
- **WHEN** 既有 tests 或 modules import runtime event extraction 與 processed-event conversion APIs
- **THEN** 這些 imports 必須維持可用
- **AND** known runtime events 必須持續轉換成相同 visible activity titles 與 data semantics

#### Scenario: Activity timeline receives processed events
- **WHEN** activity events 在 chat UI 中 render
- **THEN** existing known processed event data 必須維持與 activity timeline 相容
- **AND** 不得改變 Tool Result rendering contract

#### Scenario: Existing cancellation behavior is tested
- **WHEN** 使用者取消 loading response
- **THEN** frontend chat 必須仍保留 terminal assistant bubble after cancellation
- **AND** next submit 必須仍清除該 local cancel placeholder

### Requirement: Frontend chat MUST classify BFF stream error codes structurally

Frontend chat MUST map BFF stream error codes to local stream terminal kinds without parsing display text.

#### Scenario: BFF timeout code is received

- **WHEN** frontend receives an `ErrorEnvelope` with code `bff_timeout` or `upstream_timeout`
- **THEN** frontend MUST classify the stream failure as `timeout`
- **AND** timeout MUST remain an error terminal state rather than successful completion

#### Scenario: BFF client disconnect code is received

- **WHEN** frontend receives an `ErrorEnvelope` with code `client_disconnected`
- **THEN** frontend MUST classify it as an abort-like terminal signal
- **AND** reducer terminal idempotency MUST prevent cancelled or errored state from re-entering running

#### Scenario: BFF upstream stream error is received

- **WHEN** frontend receives an `ErrorEnvelope` or SSE error frame with code `upstream_stream_error`
- **THEN** frontend MUST classify it as `generic` stream error unless a more specific structured code exists
- **AND** frontend MUST display a safe user-facing error message

#### Scenario: Unknown BFF stream error code is received

- **WHEN** frontend receives an unknown BFF stream error code
- **THEN** frontend MUST safely degrade to generic stream error
- **AND** frontend MUST NOT parse natural-language message text to infer state

### Requirement: Frontend chat MUST handle trailing SSE error frame safely

Frontend chat MUST not crash or silently treat a trailing SSE `event: error` as normal success.

#### Scenario: SDK surfaces trailing SSE error through error callback

- **WHEN** the LangGraph SDK exposes the trailing SSE error frame via stream error callback
- **THEN** frontend MUST parse the structured `ErrorEnvelope`
- **AND** dispatch an error terminal transition

#### Scenario: SDK surfaces trailing SSE error through update callback

- **WHEN** the LangGraph SDK exposes the trailing SSE error frame as an update event
- **THEN** frontend MUST either convert it to a structured stream error or safely skip it without crashing
- **AND** it MUST NOT append malformed activity data that causes terminal state regression

