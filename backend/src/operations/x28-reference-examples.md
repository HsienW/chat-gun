# X28 私有 composition 可執行參考案例

從 `backend/` 執行下列命令；五個測試檔使用受信組裝或注入的 mock port，不讀取憑證、不直呼未受治理的 Tool，也不啟動 Agent Server：

```powershell
npm run test -- src/operations/runtime-composition.test.ts src/runtime/authorization/confirmation-graph.test.ts src/runtime/recovery/conversation-recovery.integration.test.ts src/platform/llm-gateway-fallback.test.ts src/runtime/framework-adapters/reference-adapter.test.ts
npm run build
```

| 案例 | 可執行測試與觀察點 | 對應 X28 契約 |
| --- | --- | --- |
| Single-agent Tool | `runtime-composition.test.ts` 的 `runs %s through the same dispatch, event and terminal owners`：分別由 reference adapter 與真實 LangGraph node，以私有 `RuntimeComposition` 注入受信 identity、X14 dispatch、usage 與 X19 publication；驗證相同拒絕結果、run/task/step、一次 dispatch、一次 publication。 | `chat-gun-runtime-composition` 的單一組裝與 Graph／非 Graph Tool 同路徑；`framework-adapter-interface` 的第二 adapter。此例只證明 deterministic／mock host 配對，完整治理矩陣仍待 T3.2。 |
| Approval／resume | `confirmation-graph.test.ts` 的 `interrupts and resumes on the same thread before one physical dispatch`：受信政策先建立 confirmation descriptor 與 durable manifest，Graph interrupt 後以同一 thread 的有效 approval 恢復；恢復前零次、恢復後一次 physical dispatch。 | `langgraph-runtime-adapter` 的 interrupt、approval 與 resume。此例是 `MemorySaver` deterministic 測試，正式 store 與完整 actor／expiry／重複回覆矩陣仍待 T3.3。 |
| Checkpoint recovery | `conversation-recovery.integration.test.ts` 的 `sanitizes checkpoint history, resumes once, reconciles mutations, and stays terminal`，及 `parks an unprovable checkpoint without consuming or resuming`：用真實 LangGraph `MemorySaver` 搭配既有 recovery adapter，驗證可證明的 resume 與無法證明時的 park。 | `langgraph-runtime-adapter` 的 checkpoint、版本與恢復。此例不代表正式 Agent Server PostgreSQL／Redis 持久化，亦不替代 T3.4。 |
| Provider fallback | `llm-gateway-fallback.test.ts` 的 `routes a primary 5xx response to the configured fallback provider` 與 `preserves primary-only behavior when fallback is disabled`：只經既有 `llmGateway.createChatModelWithFallback()` 與 provider policy，mock HTTP 5xx；不在 node 用模型名稱推測輸出。 | `chat-gun-runtime-composition` 的 provider owner，以及 `langgraph-runtime-adapter` 的 provider fallback 政策。此例未呼叫 live provider。 |
| Typed failure | `reference-adapter.test.ts` 的 `parks malformed checkpoint input with a typed error before host execution`、`parks unknown versions before either execution path and preserves metadata`：無效或未知版本 checkpoint 在 host 執行前以 `CHECKPOINT_PARKED` 拒絕，原 metadata 不變。 | `framework-adapter-interface` 的 typed failure；`langgraph-runtime-adapter` 的 checkpoint 相容性。此例是 reference adapter，Graph store 整合仍待 T3.4。 |

這些範例是 deterministic／mock 證據。它們不宣告 `isolated_process` 已就緒，不發布四 Graph production composition，也不把 `MemorySaver` 結果當成正式 Agent Server live drill。T2.3 已完成私有驗收；T3.2–3.4 各自剩餘的治理矩陣與情境仍以 `tasks.md` 為準。
