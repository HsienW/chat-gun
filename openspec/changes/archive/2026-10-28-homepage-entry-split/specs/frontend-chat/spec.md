## MODIFIED Requirements

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
