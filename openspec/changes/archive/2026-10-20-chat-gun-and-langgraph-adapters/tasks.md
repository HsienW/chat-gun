# Tasks：chat-gun-and-langgraph-adapters

> **範圍縮小（Human 2026-10-20 裁定）**：本 change 只交付可獨立成立的 composition 能力，以 deterministic／mock／recorded 證據驗收；`isolated_process` 生產 substrate、sandbox production 發布與 production composition publication 移至 `sandbox-execution-runtime` 與後續 composition-publication change。已驗證完成：T1.4、T2.1。部分完成：T2.2a（私有原子組裝入口＋canonical execution 測試）。延期：T2.2b（四 Graph 正式接線）、T5.1（live drills）、T5.2（rollout）。所有驗收 gate 維持 false，待 Qwen review-plan 核准；核准前不發布、不 Archive、不解除 gate。
>
> **身分權威仲裁（CCR 2026-10-20）**：apply-change 發現既有 `graph-entry` 把 native `configurable.run_id` 當產品 `runId`。CCR 裁定產品 `runId` 由受信 admission 邊界建立／恢復，native `run_id` 僅作私有非授權 correlation；已補入 `langgraph-runtime-adapter/spec.md` 與 `design.md` Decision 2，本輪交 Qwen re-review-plan，核准後再由 Codex 完成 T3.1–3.6。T3.1–3.6 以 deterministic／mock／recorded 私有驗證，不接四 Graph production composition。

## 1. 契約與依賴基線

- [x] 1.1 核對 X11–X21、X26、X27 已核准 artifacts、公開 package 版本與 API-surface；建立 graph/node/checkpoint/Run/Task/Step/tool 權威與符號級現況表，標示四個 Graph 及正式 Server 尚未實證之處。驗證：`openspec validate chat-gun-and-langgraph-adapters --strict`、`cd backend && npm run build`；附上來源 revision、版本與盤點證據。對應三份 spec 的前置條件。
- [x] 1.2 盤點 `backend` 四 Graph、graph-entry、checkpoint/recovery、X14 registry/dispatch、X13 authorization、X25 sandbox、X19 events、BFF Abort/stream 與 frontend terminal/parser；固定 graph/non-graph baseline 及失敗/取消 fixture，建立受影響欄位和相容性表。驗證：`cd backend && npm run test -- src/runtime/execution-context/ src/runtime/recovery/ src/runtime/tool-dispatch/`；記錄既有測試與缺口。對應 `chat-gun-runtime-composition`、`langgraph-runtime-adapter`。
- [x] 1.3 在 T2.x 前完成 harness public API-surface/owner gate。CCR 已裁定：X28 的 framework-neutral port 與 `CheckpointAdapterMetadataV1` 採 backend 私有 port，不新增 public export，公開化為獨立 gated change；實作須引用既有公開 `ExecutionManifestRef`／`RuntimeVersionSet` 且不得私加 export，私有 port 不得宣稱 public portability。驗證：`cd backend && npm run test -- src/runtime/index.test.ts src/operations/architecture-checks.test.ts`、`cd ../gun-harness && npm run check`（須以實際 owning repo checkout 執行），保存 API-surface 決策與依賴證據。對應 `framework-adapter-interface`。
- [x] 1.4 在 T2.1／T2.3／T3.4 前建立共用 `CheckpointAdapterMetadataV1` 的 typed/runtime schema 與單一 compatibility gate，驗證既有 `ExecutionManifestRef`／`RuntimeVersionSet` 的引用與欄位 owner；覆蓋 LangGraph/第二 adapter 相同 metadata 的 compatible、migratable、unknown/incompatible、缺欄位、未知欄位、身分衝突及 legacy migration/park，證明原 checkpoint 不變。若需公開欄位，先回 T1.3。驗證：`cd backend && npm run test -- src/runtime/persistence/ src/runtime/recovery/ src/operations/manifest.test.ts`、`npm run build`；附 schema/version/compatibility 對照表。對應 `langgraph-runtime-adapter`「Graph checkpoint 與版本相容性」及 Qwen Major finding。

## 2. 中立介面與產品組裝

- [x] 2.1 完成 T1.3/T1.4 gate 後實作最小 framework adapter 契約與 capability/version 驗證：invocation、step、checkpoint、wait/resume、event、cancel、terminal observation；缺能力、未知版本、初始化逾時/取消皆 typed fail 且原子註冊。驗證：`cd backend && npm run test -- src/runtime/`、`npm run build`；加上成功及缺能力/逾時/取消單元測試。對應 `framework-adapter-interface`「框架中立 adapter 契約」。
- [x] 2.2a 建立單一受信 Chat Gun composition root（私有原子組裝入口），注入 identity、persistence、policy、provider/tool registry、sandbox/secret broker、scheduling、event publication 與 usage hooks；缺必要服務（含 sandbox runner）或版本不相容在 serve traffic 前以 typed failure 拒絕（`COMPOSITION_DEPENDENCY_UNAVAILABLE`），保留原可用集合。驗證：`cd backend && npm run test -- src/operations/ src/runtime/`、`npm run build`；新增整批發布/缺依賴/逾時/取消與 no-parallel-owner 測試。對應 `chat-gun-runtime-composition`「單一受信 composition root」。**狀態：私有原子組裝入口＋canonical execution 測試已完成（缺依賴/版本/逾時/取消/部署競態）；production publication 屬 2.2b，未接線。**
- [ ] 2.2b（**延期**：移至後續 composition-publication change）四 Graph 正式接線至單一 composition root 並 production publication——需 `sandbox-execution-runtime` 的 concrete runner 就緒；延期期間不發布，維持 fail-closed。
- [x] 2.3 完成 T1.4 後用無 LangGraph import 的最小 reference adapter 執行成功、wait/resume、失敗、逾時、取消、unknown version 與完成/取消競態；使用同一 checkpoint metadata schema/compatibility gate，證明同一 contract 與 terminal guard 不需 kernel 變更。驗證：`cd backend && npm run test -- src/runtime/ src/operations/`、`npm run build`；加上 owning repo boundary/cycle/API-surface check。對應 `framework-adapter-interface`「第二 adapter」及「公開邊界」。**2026-10-20 驗證：指定範圍 1,272 passed／1 skipped；新增 reference／LangGraph node 的 canonical dispatch、event、terminal 配對後，backend 全量 2,055 passed／36 skipped；lint/build、owning repo check 34 tests、architecture/API-surface 與 clean consumer provenance 通過。證據：本機 `evidence/x28-postgres-validation-20261020.md`（CurrentState 引用）。僅驗收私有 deterministic／mock 能力。**

## 3. LangGraph 映射與治理

- [x] 3.1 接入 graph invocation → run/task、node → step/attempt、native Run/Thread/checkpoint → correlation 映射；產品 `runId` 由受信 admission 邊界以 `randomUUID()` 產生並寫入 canonical `execution_context` 與 admission binding（`graphEntry.initialRunId`），resume 由 durable binding 取回並重驗 owner；native `run_id` 僅存 backend 私有非授權 `nativeRunId`，不得進入產品 `runId`／authorization 主鍵／admission lock key；缺受信身分、resume 衝突、缺 binding、admission 逾時/取消皆 typed fail（含 `CHECKPOINT_PARKED`）。驗證：`cd backend && npm run test -- src/runtime/execution-context/ src/agents/`、`npm run build`；新增同 thread 並行 Run、node retry、缺 ID、缺 binding park、取消測試。以 private reference adapter＋`MemorySaver`＋mock admission 的 deterministic 證據驗證，不接四 Graph production composition（T2.2b 延期）。對應 `langgraph-runtime-adapter`「身分映射」與「產品 Run ID 與 native Run correlation 分離」。
- [x] 3.2 讓 graph tool node 僅經 canonical manifest/同一 registry 與 X14 dispatch；配對比較 Graph/非 Graph 的授權、schema、sandbox/egress、timeout、取消、side-effect ledger 與 event correlation，不保留直呼 executor。驗證：`cd backend && npm run test -- src/runtime/tool-dispatch/ src/runtime/authorization/ src/tools/`、`npm run build`；保留 Weather/Web/Calculator/MCP 既有回歸。對應 `chat-gun-runtime-composition`「Graph tool 同路徑」。
- [x] 3.3 將 LangGraph interrupt 對接既有 durable wait/approval/resume gate；測試 checkpoint 先保存、合法 actor 單次恢復、無權/過期/重複回覆、等待期間 timeout/取消與恢復前副作用不重播。驗證：`cd backend && npm run test -- src/runtime/recovery/ src/runtime/authorization/`、`npm run build`。對應 `langgraph-runtime-adapter`「Interrupt、approval 與 resume」。
- [x] 3.4 在 T1.4 的共用 metadata schema/gate 上接入可持久 graph state 與 opaque state 隔離；對不可序列化/含 secret、invalid/unknown version、store timeout/取消、deploy 後 resume 提供 typed failure、park 與原 checkpoint 不變證據。驗證：`cd backend && npm run test -- src/runtime/persistence/ src/runtime/recovery/ src/operations/manifest.test.ts`、`npm run build`。對應 `langgraph-runtime-adapter`「Graph checkpoint 與版本相容性」。
- [x] 3.5 將 graph/model/tool 串流只正規化一次至 X19 event；以既有 event identity、run-scoped sequence、correlation 與 terminal guard 處理 duplicate、亂序、stream 中斷、node exception、step limit。驗證：`cd backend && npm run test -- src/runtime/events.test.ts src/runtime/event-envelope.test.ts src/runtime/runtime-event-contract.test.ts src/agents/`、`npm run build`。對應 `langgraph-runtime-adapter`「Stream、retry 與產品終態」。
- [x] 3.6 傳播 request/job cancel/deadline 至 graph、model、tool 與等待中的 child；framework retry 對齊 step attempt、idempotency/ledger，對 ambiguous external commit 停止自動重播並 reconcile，成功/取消競態僅一個產品 terminal。驗證：`cd backend && npm run test -- src/runtime/retry/ src/runtime/idempotency/ src/runtime/side-effect/ src/runtime/interaction/`、`npm run build`。對應 `langgraph-runtime-adapter`「Stream、retry 與產品終態」。

## 4. 跨層相容性與範例

- [x] 4.1 BFF 驗證 trusted request/correlation、stream 原樣透傳、Abort/timeout、typed error 與未知 additive metadata；若契約變更，補 runtime validation，不讓 BFF 承擔 graph 語意。驗證：`cd bff && npm run test && npm run build`，加上 cancel/timeout/unknown-field 回歸。對應 `chat-gun-runtime-composition`「傳輸與呈現相容」。
- [x] 4.2 Frontend 驗證 wait/resume、typed failure、未知 event/field、duplicate/亂序/late terminal 的安全呈現；不由 framework metadata 推斷授權。驗證：`cd frontend && npm run lint && npm run test && npm run build`。對應 `chat-gun-runtime-composition`「傳輸與呈現相容」。
- [x] 4.3 撰寫可執行參考範例：single-agent tool、approval/resume、checkpoint recovery、provider fallback、typed failure；範例使用受信組裝與既有 provider policy，不含憑證或直呼 tool。驗證：`cd backend && npm run test -- src/agents/ src/runtime/recovery/`、`npm run build`；文件審查逐例對照三份 spec。

## 5. 部署、回滾與完成門檻

- [ ] 5.1（**延期**：移至後續 composition-publication change，需正式環境與 sandbox ready）在正式 Agent Server + PostgreSQL/Redis 以四個 Graph 分別執行 create/stream/interrupt/restart/resume/cancel/terminal lookup，對照 native Run/Thread、實際 checkpoint 欄位/版本與產品 Task/Step/ledger；另執行 forced kill、store 故障、first checkpoint 前終止、Tool commit 後 result 持久化前中止。驗證：新增 `backend` 的 `test:x28:agent-server` 可重播 script 後執行 `cd backend && npm run test:x28:agent-server`，保存固定 runtime/image 版本、環境與結果；未跑的 drill 保持此 Task 未完成。對應 `langgraph-runtime-adapter` 的 checkpoint、wait、stream、cancel 要求。本項不納入 X28 composition deliverable 的完成門檻。
- [ ] 5.2（**延期**：移至後續 composition-publication change）對每個逐 Graph rollout 比較 legacy/adapter 的成功、拒絕、timeout、取消、事件與 side-effect；驗證舊 checkpoint 讀取、相容升版及 downgrade/rollback，incompatible resume park 且不污染持久資料。驗證：`cd backend && npm run lint && npm run test && npm run build`；新增版本固定的 `test:x28:rollback` script 後執行 `cd backend && npm run test:x28:rollback`。對應三份 spec 的相容及回滾情境。本項不納入 X28 composition deliverable 的完成門檻。
- [x] 5.3 執行 owning repo 的 package check、public API/boundary/cycle tests 及可追溯 consumer 安裝；再完整執行 `cd ../gun-harness && npm run check`（如本 change 修改該 repo）、`cd backend && npm run lint && npm run test && npm run build`、`cd bff && npm run test && npm run build`、`cd frontend && npm run lint && npm run test && npm run build`、`openspec validate chat-gun-and-langgraph-adapters --strict` 與 `git diff --check`。保存 deterministic、mock、live、跨平台及未執行項目；任何必要 gate 未過不得勾選本項或宣稱 X28 完成。**2026-10-20 驗證：owning repo 34、backend 2,055、BFF 10、frontend 180 tests passed；必要 lint/build、OpenSpec strict、diff check 通過。四個固定版 harness 套件完成全新 registry consumer 安裝與 integrity 比對。backend 36 個 opt-in 測試略過；僅驗證 Windows host 與本機 Docker PostgreSQL，未驗證正式 Agent Server、live Provider、Linux/macOS host。證據同上。本項完成不代表 T3.1–3.6 或最終 implementation/readiness gate 通過。**

## 6. 完成定義

X28 的 composition deliverable 完成門檻（以 deterministic／mock／recorded 證據驗收）：

- T1.1–1.4、T2.1、T2.2a、T2.3、T3.1–3.6、T4.1–4.3、T5.3 全部通過；
- 三份 spec 的 sandbox-independent Requirements／Scenarios 全數有驗證證據；
- `framework-adapter-interface` 的私有 port 與公開邊界 gate 未被破壞；
- 延期項（T2.2b、T5.1、T5.2、`isolated_process` 生產 substrate、sandbox production 發布、live isolation）不納入本 change 完成，由其承接 change 驗收。

production publication 與 live isolation 屬後續 composition-publication change 之完成門檻；該 change 完成前，X28 不得宣告 production-ready。

> **2026-10-20 T3.1–3.6 私有驗收**：Scenario／測試對照見 `backend/src/operations/x28-scenario-evidence.md`。backend 全量 2,095 passed／36 skipped，lint（22 additive checks）與 build 通過。真實 PostgreSQL native retry 兩案例均只有一次實體副作用。所有 active Tasks 已完成，交 Qwen review-result；延期 T2.2b／T5.1／T5.2 保持未勾選，最終 implementation/readiness gate 不由 Codex 自行解除。
