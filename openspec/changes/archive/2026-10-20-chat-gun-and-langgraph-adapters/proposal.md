## Why

X26 已把穩定契約抽到 `gun-harness`，X27 已提供 SDK manifest，但 Chat Gun 的 graph 入口、checkpoint、interrupt、tool 與串流仍缺少一份可審查的整合契約。若直接把 LangGraph 的 run/checkpoint 語意當成產品權威，將無法證明 X13/X14/X19/X20/X25 的身分、授權、副作用與終態保證跨 graph 執行後仍成立。X28 要在既有 runtime 上完成這層明確映射。

## What Changes

- 定義 Chat Gun 單一 composition root：注入 identity、persistence、policy、provider/tool registry、sandbox/secret broker、scheduling、event publication 與 usage hooks；保留 `gun-harness` framework-neutral 邊界。
- 定義 LangGraph adapter：graph invocation 與 node、checkpoint、interrupt、tool、stream、retry、cancel、terminal outcome 映射至既有權威 runtime；graph traversal 仍由 LangGraph 控制。
- 定義最小 framework adapter 介面及非 LangGraph reference adapter 的驗收，證明整合不需修改 kernel 或重建第二個 executor。
- 以版本化 checkpoint/adapter metadata、typed compatibility outcome、恢復與回滾測試處理升版、crash 及不可序列化 state；提供單 agent tool、approval/resume、checkpoint recovery、provider fallback、typed failure 範例。

本次不要求破壞既有 Graph ID、BFF route、event envelope 或 error-code 語意；如實作盤點發現必須修改既有公開契約，應先補 delta spec 並重新審查。

**範圍縮小（Human 2026-10-20 裁定）**：本 change 只交付可獨立成立的 composition 能力——單一受信 composition root、框架中立 adapter 契約、`CheckpointAdapterMetadataV1`、第二 reference adapter 與 LangGraph 身分／checkpoint／interrupt／stream 映射，全部以 deterministic／mock／recorded 證據驗收。`isolated_process` 的 concrete 執行 substrate 與 sandbox production 發布（含四 Graph 正式接線、production composition publication、live isolation 驗證）移至後續 change：concrete runner 由 `sandbox-execution-runtime` 承接，production publication 由後續 composition-publication change 承接。延期期間 X28 不得宣告 sandbox-ready、不得以 `trusted_in_process` 子集冒充 sandbox、不得退回無限制 host 執行。

## Capabilities

### New Capabilities

- `chat-gun-runtime-composition`：產品依賴在單一受信 composition root 綁定至 harness/runtime，保留單一路徑與跨層傳播。
- `langgraph-runtime-adapter`：LangGraph graph/node/checkpoint/interrupt/tool/stream 與權威 runtime 的身分、生命週期、相容性和故障映射。
- `framework-adapter-interface`：框架中立的 adapter 契約、能力宣告與最小第二 adapter 驗收，避免 kernel 相依 LangGraph。

### Modified Capabilities

無。現有 `harness-consumer-integration`、`sdk-runtime-integration`、`canonical-execution-context`、`runtime-event-contract`、`langgraph-runtime-boundary` 等主規格保持有效；新能力只能加強其已核准不變量。若審查確認其中 Requirement 必須改變，須先在本節新增對應能力及 delta spec。

## Impact

- **目標與範圍**：`backend` 的 graph 入口、execution context、checkpoint/recovery、approval、tool dispatch、event/terminal 與 composition root；`bff` 的取消、stream 及 correlation 透傳；`frontend` 的 wait/resume、未知欄位與 terminal 呈現相容性；`gun-harness` 的 framework-neutral public surface 如有新增，須有 owner、API-surface 與版本證據。
- **公開/私有邊界裁定**：X28 的 framework-neutral adapter port、capability/version 宣告與 `CheckpointAdapterMetadataV1` 本 change 採 `backend` 私有 port（單一來源、有型別、有 runtime validation），不從任何 `@gun-ai/harness-*` 套件 export，亦不宣稱已發布 public 契約；其版本相容沿用既有公開 `ExecutionManifestRef`（`@gun-ai/harness-contracts`）與 `RuntimeVersionSet`／`evaluateRuntimeVersionCompatibility`（`@gun-ai/harness-kernel`），不另立平行版本機制。提升為 public API 是獨立 additive change，須先有可驗證的外部 consumer use case，並完成 owning package、`@since` 版本、API-surface snapshot、semver 與 rollback 審查後重新 review-plan。
- **非目標**：重建 Agent Server queue/worker、另建 tool executor/authorization、讓 checkpoint ID 成為產品身分、將 LangGraph 或 Chat Gun 專屬依賴引進 harness kernel、fork LangGraph private internals、以 mock 成功宣稱正式 persistence 已驗證。
- **安全與相容性風險**：trusted identity/approval 若由 framework state 回填、graph retry 重複外部副作用、取消與成功競態產生雙 terminal、未知 checkpoint 版本被誤讀，皆可能破壞既有權威契約。正式 Agent Server 的 PostgreSQL/Redis 與 `MemorySaver` 關係須以 live 證據確認，不得依 `langgraph dev` 推論。
- **回滾策略**：新 adapter 逐步接到現有 graph，保留原入口與事件/序列化相容；每一步以同一 dispatcher 的配對測試和已存 checkpoint 的 downgrade/read 測試守門。若兼容 gate 失敗，停止 rollout、pin 舊版 adapter/runtime 並將不安全 resume 停在 typed operator resolution，不重播不確定副作用。
- **依賴**：X11–X21、X26、X27；規劃與實作前應核對已核准成果及跨 repo package 版本。此 proposal 不代表依賴或 live smoke 已重新驗證。production composition publication 另依賴 `sandbox-execution-runtime` 就緒與後續 composition-publication change；本 change 的 composition deliverable 完成不以此為前提。
