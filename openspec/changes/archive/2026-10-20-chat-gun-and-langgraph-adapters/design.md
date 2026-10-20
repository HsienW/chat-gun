## Context

X28 依賴 X11–X21 的 runtime 原語、X26 的 `@gun-ai/harness-contracts`／`kernel` 及 X27 的 SDK manifest。Chat Gun 目前有四個公開 Graph（`chatbot`、`math_agent`、`mcp_agent`、`deep_researcher`），已有 graph-entry context resolver、checkpoint recovery adapter、X14 dispatch pipeline、X13 authorization 與 X19 event envelope；`deep_researcher` 使用 explicit `MemorySaver`，其餘 Graph 由 LangGraph Server 管理 checkpoint。這些事實不等於四個 Graph 已共用一個完整的 X28 composition adapter。

既有 `langgraph-runtime-boundary` Decision Record 指定 native Run API 的 `run_id`／`status`、Thread state 的 checkpoint identity 各有權威來源；Chat Gun 的 Task/Step、可見 run ownership、approval、side-effect ledger 及產品終態仍屬產品/runtime 決策。正式 Agent Server 的 PostgreSQL/Redis persistence 與 `MemorySaver` 覆寫關係尚缺 live 證據。主規格 `harness-package-boundary` 禁止任何 `@gun-ai/harness-*` 套件 import LangGraph、產品或 DB client；本計畫維持這條邊界。

相關人員：CCR 負責契約與跨 repo 計畫、Qwen 唯讀審查、Codex 實作；Human 管理外部套件發版、正式環境與最後 Git 操作。

## Goals / Non-Goals

**Goals:**

- 用一個受信組裝點綁定 identity、persistence、policy、provider/tool registry、sandbox/secret broker、scheduling、event publication、usage hooks，讓 graph 與非 graph 工具執行走同一權威 pipeline。
- 明訂 graph invocation/node/checkpoint/interrupt/tool/stream/terminal 與 run/task/step/attempt 的映射、版本相容和取消／重試語意。
- 定義不依賴 LangGraph 的最小 adapter 契約，並以第二個 reference adapter 作實證。
- 以 deterministic、mock/recorded、正式 Agent Server live 及跨層相容性證據分級驗收；不把本次規劃文件視為 live 證據。

**Non-Goals:**

- 建立第二套 queue/worker、tool executor、authorization、checkpoint store 或產品 Run ID。
- 修改既有公開 Graph ID、BFF route、error-code 語意；讓 framework 回填 trusted identity、approval 或 billing 身分。
- 宣稱 `langgraph dev` 的 persistence 結果等同正式 Agent Server，或把框架私有 API 直接寫入穩定合約。
- 交付 `isolated_process` 的 concrete 執行 substrate、sandbox production 發布、四 Graph 正式 production 接線或 live isolation 驗證（2026-10-20 範圍縮小裁定：由 `sandbox-execution-runtime` 與後續 composition-publication change 承接）。

## Decisions

### 1. 契約所有權與 adapter 位置

`gun-harness` 只擁有框架中立的 execution、port 與 serialized compatibility 契約；若已發布 public surface 缺能力，先做符號層級 inventory 與 API-surface review，再以 additive 版本提案。LangGraph adapter 與 Chat Gun composition root 留在 `backend`，使用公開 LangGraph API；產品依賴只在此注入。`testkit` 可提供中立 fixture，但不得使 `contracts`／`kernel` 反向依賴它。

備選是在 kernel 直接 import LangGraph 或另建 `gun-harness` LangGraph package；前者違反既有 package boundary，後者增加發版／版本 tuple，除非後續審查提出必要性，X28 不先採用。若現有 harness 公開介面無法承載此設計，應回到 proposal/新 delta spec，不在實作時私加 public export。

**本 change 裁定**：T1.3 已證實 `@gun-ai/harness-*@0.1.0-alpha.2` 公開面缺 framework-neutral adapter port 與 checkpoint metadata schema。X28 採 `backend` 私有 port（含 `CheckpointAdapterMetadataV1`）先實作，引用既有公開 `ExecutionManifestRef`／`RuntimeVersionSet`，不新增任何 public export；公開化為獨立 gated additive change（需 external use case、owning package、`@since`、API-surface snapshot、版本發版與獨立 review-plan）。

### 2. 單一 composition root 與 graph 身分映射

由 `backend` 一個受信組裝點注入 graph adapter 需要的服務，覆蓋既有 scattered assembly 而非併存第二個 authority。入站 trusted context 經 BFF 驗證並由既有 graph-entry 邊界產生/取得 `ExecutionContext`。mapping 表由 typed context 維持：native `run_id`／`thread_id`、graph ID、node path、checkpoint ID/namespace 是 framework correlation；產品 `requestId`、`runId`、`taskId`、`stepId`、`attempt`、`toolCallId` 與 principal/tenant 是受信 runtime identity。不可把 native `checkpoint_id` 或 graph node 名稱轉作授權主鍵；resume 使用持久關聯而非隱式相等。

每次 graph invocation 建立或恢復一個產品 task；node entry/exit 關聯明確 step/attempt，重試增 attempt 而不創建平行產品 run。既有 native Run API 仍決定 native Run status；產品 terminal projector 在取得 native status、Task/Step、side-effect/approval 真相後只提交一次產品終態。Native Run `success` 與 Thread `interrupted` 可並存，不得用 Thread 或文字訊息反推產品完成。若所需關聯缺失，fail closed 為 typed error，不捏造 ID。

備選是以 `thread_id`/`checkpoint_id` 充當產品 ID，會讓 resume、並行 Run、授權與稽核混淆，故拒絕。

**身分權威仲裁（CCR 2026-10-20）**：apply-change 期間確認既有 `graph-entry` 直接把 `configurable.run_id` 當成產品 `ExecutionContext.runId`（`read-execution-context.ts` 的 `runId`/`run_id` alias、`graph-task-admission.ts` 的 `initialRunId` 與 advisory lock 皆沿用該值）。裁定產品 `runId` 的受信來源為 backend admission/composition 邊界：新 invocation 以 `randomUUID()` 產生產品 `runId` 並寫入 canonical `execution_context` 與 admission binding（`agent_tasks.metadata.graphEntry.initialRunId`）；resume 由 durable binding 取回並重新驗證 thread／principal／tenant／scope owner。native `configurable.run_id` 只存入 backend 私有、非授權 correlation 欄位 `nativeRunId`（僅供 tracing／native status 查詢），不得進入產品 `runId`、authorization 主鍵或 admission lock key。缺 binding、身分衝突或 correlation 版本不符一律 typed `CHECKPOINT_PARKED`／`incompatible`，保留原 checkpoint。`readExecutionCorrelation` 對 graph 呼叫的 legacy `run_id`→`runId` 別名提升在存在 canonical `execution_context` 時不再生效，故 native `run_id` 不會被誤升為產品 ID；這與主規格 `canonical-execution-context` 的「單一 adapter 映射邊界」相容（adapter 仍存在，X28 邊界改由直接產生 canonical context）。此裁定需補入 `langgraph-runtime-adapter` spec 並重走 Qwen review-plan 後再 apply-change。

### 3. Tool、approval 與受信能力

graph tool node 僅經 X27 canonical manifest/同一 registry 取得 descriptor，實際執行由 X14 pipeline 負責；X13 authorization、X25 profile/sandbox/egress/secret broker、side-effect ledger、X19 event 均在同一路徑。graph state 的工具名稱與參數只是未受信請求，必須經 canonical schema 與 policy；hook、interrupt payload 不能改 principal、tenant、approval、billing、權限決策。Interrupt 先保存可恢復 state 與 durable wait reference，resume 再經既有 approval/authorization gate 校驗 actor、scope、expiry、版本與單次使用。

備選是 graph node 直接呼叫 tool 或讓 LangGraph interrupt 本身代表 approval；兩者都繞過既有權威邊界，故拒絕。對 MCP 與 mutation tool 保留預設拒絕、最小 egress 與經受信 host 提供的 credential；checkpoint/event/log 不存 plaintext secret。

### 4. Checkpoint、版本與恢復

adapter 只將宣告為可恢復且 JSON-safe 的 graph state 與最小 metadata 持久化，對不可序列化欄位做 typed checkpoint failure，不默默省略。T1.4 先定義唯一的 `CheckpointAdapterMetadataV1` schema；LangGraph 與最小第二 adapter 共用同一 parse/compatibility gate，不得各自定義欄位或自行降級。持久化投影包含：`schemaVersion: "1.0.0"`、穩定 `adapterId`、SemVer `adapterVersion` 與 `stateSchemaVersion`、既有 `ExecutionManifestRef`、既有 `RuntimeVersionSet`、`nativeCheckpointRef`（`threadId`、`checkpointId`、允許空字串的 `checkpointNamespace`）、`productIdentityRef`（`runId`、`taskId`；`stepId` 與正整數 `attempt` 成對出現，只有 node checkpoint 才需要）。Graph ID、graph config hash 與既有 schema versions 只從 `ExecutionManifestRef` 取得，不複製為另一份權威欄位；approval 與 side-effect reference 仍由既有持久化契約關聯，不把憑證、完整 principal、執行期物件或 opaque framework payload 放入 metadata。每一欄有明確 owner、上限與 runtime validation；新格式拒絕未知欄位。

相容性順序固定：先驗證 metadata schema/必要欄位與 identity correlation，再以既有 execution manifest 與 runtime version gate 判定，最後檢查 adapter ID、adapter version、state schema version 的支援矩陣。全部相容才 resume；只有明確註冊且可回滾的 migration 才回傳 `migratable`；缺欄位、未知版本、ID 不符、損毀或不相容一律 typed `unknown`/`incompatible` 並 park，保留原 checkpoint，不猜測可恢復性。Legacy checkpoint 未帶 X28 metadata 時，只能在既有可驗證 `ExecutionManifestRef` 與已批准的 migration path 下恢復；否則 park。Opaque framework payload 限內部隔離區，除跨 adapter 恢復有已審查需求，不進 public serialized contract。若 T1.3 判定此 metadata 必須成為公開跨套件契約，先確認 owning package/API surface 與版本化發版；發版前可在 backend 內部共用，但不得稱為已發布的 public port。

首批以四個 Graph 分別盤點 checkpoint 策略及正式 Agent Server 真實行為，再逐 Graph 遷移；尤其 `MemorySaver` 與 server-managed persistence 的關係要在正式部署實測後決定。備選是直接搬移/重寫 native checkpoint DB；會破壞持久化與升版邊界，故拒絕。

### 5. Stream、取消、重試與終態

graph/model/tool stream 在 adapter 的單一正規化邊界轉成既有版本化 X19 envelope；保留 `requestId/threadId/runId/taskId/stepId/toolCallId`、event identity、run-scoped sequence，既有 BFF 只透傳，frontend 依 event contract 去重和 bounded reordering。原始 native event 不再另送一份產品 terminal。請求/job 的 AbortSignal 傳至 graph、model、tool 和等待中的 child；取消與完成競態由既有 CAS/terminal guard 裁定唯一產品 outcome，已提交或不確定副作用進 reconciliation，不能被「取消成功」掩蓋。

框架 retry 必須對齊產品 step attempt、idempotency key、side-effect ledger；若 native retry 無法提供必要關聯，禁止自動重播 mutation，改成 typed reconcile/manual intervention。timeout、recursion/step limit、node exception、stream 中斷與初始化失敗保留各自 typed cause，不能全併成 500。Provider fallback 仍透過既有 provider policy/adapter，不在 LangGraph node 以模型名硬映射。

### 6. 最小第二 adapter 與跨層責任

框架中立介面只暴露 invocation、step observation、checkpoint reference、wait/resume、event source、cancel/terminal observation 的必要能力及 typed failure；不暴露任意 middleware 或框架 private object。用一個 deterministic、無 LangGraph import 的 reference adapter 跑同一套 lifecycle、dispatch、cancel、version 與 terminal conformance，作為可攜性最低證據。

`bff` 保持驗證、trusted principal/request ID、stream proxy、Abort/timeout、typed error 映射，不取得 tool/MCP secret 或負責 graph scheduler。`frontend` 只呈現 wait/resume、typed failure 與 terminal 狀態，對 additive/unknown event 安全降級，不解析 framework metadata 以重建授權或業務狀態。若 X28 沒有新 transport 欄位，兩層以 contract tests 證明既有行為；若需要新欄位，先補相容性規格與 runtime validation。

## Risks / Trade-offs

- [正式 Agent Server checkpoint 來源未完整實證] → 在正式 PostgreSQL/Redis 部署做 restart、forced kill、resume 與 DB state 對照；無 live 證據前不可標記相關 task 完成。
- [既有各 Graph 組裝點分散] → 先盤點四 Graph 的入口/registry/checkpointer，再以一個 Graph 做配對測試逐步替換，避免雙重 dispatch。
- [native Run status 與產品 terminal 被誤合併] → 保留各自權威來源，增加組合及競態測試；拒絕缺少映射的結果。
- [unknown external commit 被 retry] → 以 ledger/idempotency gate park 並 reconcile，禁止非冪等自動重播。
- [跨 repo public surface/版本相容] → 先核對 X26/X27 contract/API surface 與 release ownership；新 public API 需版本與獨立 consumer CI，不能以本地 link 取代。
- [scope 擴大到 BFF/frontend] → 以 additive transport 與 contract tests 為先；確有行為變更才修改相鄰程式並完成其驗證。

## Migration Plan

1. 對 X11–X21、X26、X27 與四 Graph 現況建立符號級映射與依賴證據；補正式 Server baseline，確認受影響的 public API、event/schema 與版本 tuple。
2. 在新 adapter boundary 下建 framework-neutral conformance 與第二 adapter，確認 kernel 不變且 dependency/cycle 檢查通過。
3. 以單一 graph/工具路徑建立 staging composition，配對驗證 legacy 與 adapter 的 identity、dispatch、authz、sandbox、event、terminal；逐 Graph 遷移並保留可回滾入口。
4. 分別驗證 checkpoint/approval/resume、取消/重試/ambiguous commit、BFF/frontend 承接，執行受影響套件完整 lint/test/build 及正式 Server live drills；未具備的環境如實標記 gate 未通過。
5. 發版與 rollout 前保存 API-surface、版本及已存 checkpoint 的前後/回滾讀取證據；incompatible resume park 而不破壞舊資料。若新 adapter 失敗，停用新接線、pin 舊版本並用既有 runtime 路徑恢復可相容工作；不重播不確定副作用。

## Open Questions

- X26/X27 已發布 package 的公開 symbols 是否足以表達 framework-neutral port？如不足，哪個 repo/package 取得新契約 ownership 與發版責任？在未核對 API-surface 前不指定新公開 export。
- 正式 Agent Server 對四 Graph 的 checkpoint 寫入、`MemorySaver` 與 PostgreSQL/Redis 關係，以及強制中止後 resume 的實際行為為何？依 live 證據決定逐 Graph 遷移 gate。
- `CheckpointAdapterMetadataV1` 的欄位與相容性順序已於決策 4 定義；T1.4 須驗證既有 `ExecutionManifestRef`／`RuntimeVersionSet` 能承載所需版本。若需新增公開欄位或改主規格，先完成 T1.3 的 ownership、delta spec 與重新審查，不由 adapter 私自擴充。
- X11–X21、X26、X27 的跨 repo provenance 與正式部署/測試環境如何提供給本 change 驗收？缺證據的 task 不勾選。
