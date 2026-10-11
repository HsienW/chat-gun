# web_search：可信執行入口與本輪證據隔離技術盤點

盤點日期：2026-10-11（Asia/Taipei）。狀態：調查完成，尚未施工。

續辦紀錄：使用者後續明確授權 Codex 直接實作 `execution-context-turn-evidence`，本次豁免 OpenSpec 流程。程式修改與驗證結果另存 [施工紀錄](execution-context-turn-evidence-implementation.md)。下文保留原調查時點的事實；「尚未施工」與原 workflow gate 不代表續辦現況。尚未完成真實 Agent Server／PostgreSQL／Tavily 驗收。

本文件依使用者要求保存施工上下文，不在對話展開內容。這是技術調查筆記，不是已核准 OpenSpec、實作授權、CurrentState 或完成驗收報告。

## 1. 接續工作入口

使用者後續說「開始施工」時，先讀本文件，再做下列確認，不必重新從截圖猜測錯誤：

1. 確認施工目錄、執行中服務的來源目錄與版本；目前兩者不同，不能改完錯誤目錄就宣稱已修復服務。
2. 重讀適用 AGENTS、workflow-router 與相關 skills。此項會涉及 Tool 授權、Graph State／Checkpoint、可能的 BFF 契約，屬非簡單變更。
3. 檢查是否已有本議題的核准 Change；依 CurrentState 的 phase、owner 與 Handoff 進行，不自行建立或覆寫其他 Change 的狀態。
4. 尚無 Change 時，交由 CCR Coordinator／Planner 完成正式規格與決策；Codex 不得把本筆記當成已核准的 proposal／design／tasks，也不得自行初始化 CurrentState。
5. 先建立實際入口缺少 taskId 與跨輪證據污染的失敗測試，再施工；保留 production fail-closed，不以關閉授權讓測試通過。
6. 取得目標服務重啟／測試的適當授權後，以相同 BFF 路徑重驗。單元測試通過不代表 live web_search、UI 或正式部署已通過。

本次角色：Codex 調查者；非 application implementer 階段。本次唯一檔案寫入為此筆記；未改程式、設定、規格或 Runtime Artifact，未安裝依賴、未提交 Git。

## 2. 工作目錄與證據界限

| 項目 | 已知事實 |
| --- | --- |
| 本次可寫工作目錄 | `C:/D/ai-agent/chat-gun` |
| 本次工作目錄 HEAD | `2cb3ff8f1578f927434e0d58d74b1c38efa6cc38` |
| 使用者提供入口 | `http://localhost:5173/app/` |
| 前段定位觀察的服務來源 | frontend 5173、backend 2024 的程序來源為 `C:/D/ai-agent/chat-gun-react-agent`；BFF 8787 的來源路徑未由該次程序比對確認 |
| 實際執行方式 | 經 BFF `/api/langgraph/...` 讀取 State／Runs 及建立一次新測試對話；不是直連 Runtime 繞過 BFF 的驗收 |
| 瀏覽器驗證限制 | 瀏覽器工具未成功取得可操作分頁；不得宣稱已展開 UI 或完成瀏覽器 E2E |
| 版本比對限制 | runtime repo 的 Git HEAD 在本次盤點查詢遇到 Permission denied，未繞過；完整版本差異未知 |
| 已做的局部比對 | 前段定位將六個關鍵檔案正規化 CRLF 後比較，兩目錄內容相同，見下列清單；不等於整個 repository 相同 |
| OpenSpec 現況 | `openspec list --json` 僅列出已完成的 `generalize-weather-location-resolution`（110/110）；沒有列出本議題的 Change，不挪用 weather Change 施工 |

前段定位已比對相同的六個檔案：

- `backend/src/tools/authorization/tool-authorization.ts`
- `backend/src/runtime/execution-context/read-execution-context.ts`
- `backend/src/runtime/execution-context/instrument-graph.ts`
- `backend/src/platform/tool-governance.ts`
- `backend/src/agents/deep-researcher.ts`
- `backend/langgraph.json`

本筆記以下原始碼位置均以 `C:/D/ai-agent/chat-gun` 為根；行號只作此次快照定位，後續用函式名稱重新確認。

## 3. 已取得的重現證據

### 3.1 原問題對話

| 欄位 | 值 |
| --- | --- |
| threadId | `01a124b4-424b-751e-a2c6-b104c5400e20` |
| runId | `01a124b5-ce4d-7642-b9cd-d925ada1be29` |
| web_search toolCallId | `5f93667d-9e00-4981-8423-34b74beac0ee` |
| 使用者輸入 | `今天紐約時報頭條是甚麼` |
| ToolMessage | `Error: web_search failed by tool governance - AUTHORIZATION_UNAVAILABLE` |
| Run 狀態 | `success`，只代表 Graph 結束，不代表工具成功 |
| 歷史污染條件 | 同一 State 中存在此前兩筆 `current_weather` ToolMessage |

Run 的 configurable 有 BFF identity headers、requestId／runId／threadId 對應欄位，但沒有 taskId／task_id，也沒有 canonical execution_context。

觀察到的 header 名稱包括 `x-bff-auth-source`、`x-bff-authenticated-at`、`x-bff-principal-id`、`x-bff-principal-kind`、`x-bff-principal-type`、`x-bff-roles`、`x-bff-scope-id`、`x-bff-scope-type`、`x-bff-scopes`、`x-bff-tenant-id`、`x-bff-user-id`、`x-request-id`。此處不保存身份值或任何憑證。

### 3.2 Schema 最小對照

前段定位以 runtime 安裝的 `@gun-ai/harness-contracts` 匯出之 executionContextSchema 驗證，依 reader 的實際欄位組合建立記憶體內候選值：

- canonicalExecutionContext：false。
- topLevelTaskId／configurableTaskId：false。
- requestId／runId／threadId：存在。
- 原候選值 safeParse：失敗，唯一 issue 為 `path: taskId`、`code: invalid_type`、`message: Required`。
- 僅在記憶體補入測試用 taskId 後：safeParse 成功。

這只證明 Schema 阻擋點；沒有把測試 taskId 送入 server，沒有繞過授權，也不能當成 taskId 生產配置方案。

### 3.3 新對話 live 重現

| 欄位 | 值 |
| --- | --- |
| threadId | `01a12a73-def8-7620-9e32-acfa03f19e89` |
| runId | `01a12a73-df0d-712a-9c3b-58ba093da32f` |
| toolCallId | `36682f9e-62a0-4ef3-81e7-2e08468c82be` |
| assistant_id／model | `deep_researcher`／`qwen-max` |
| 輸入 | 同原問題，`kind: prompt` |
| 研究參數 | `initial_search_query_count: 1`、`max_research_loops: 2`、`stream_mode: [updates]` |
| thread metadata | `diagnostic: web-search-authorization-reproduction` |
| 結果 | planMode research、Run success、taskId 缺少、web_search 回 AUTHORIZATION_UNAVAILABLE、searchResults 為 0 |
| 對照 | 沒有歷史 weather ToolMessage，最後回答也沒有提 weather |

這次新建的測試對話是前段定位的外部副作用，未刪除原對話。後續可用上述 ID 查回資料，但 dev server 資料不保證永久存在。

### 3.4 已執行與未執行的驗證

前段定位在 runtime repo 的 backend 執行：

```text
npm test -- src/runtime/execution-context/read-execution-context.test.ts src/runtime/execution-context/execution-context.test.ts src/platform/tool-governance.test.ts src/tools/authorization/tool-authorization.test.ts
```

結果：4 files、63 tests passed，約 3.41 秒。這是既有契約測試，不含本筆記提出的新入口或跨輪 regression；本次盤點沒有重跑。

本工作目錄先前嘗試執行相同測試時找不到 vitest，不能把另一工作目錄的成功當成本工作目錄的驗證。`/api/ready` 與 backend `/ok` 曾成功，只證明服務當時可回應。

尚未驗證：Tavily key 是否存在／有效、PG 授權資料與 migrations、正式 Agent Server PG／Redis、重啟恢復、惡意 configurable 實測、完整 frontend E2E、全部套件 lint／test／build。沒有讀取 `.env` 或輸出 key。

## 4. 失敗鏈與問題層級

```text
Browser → BFF 注入 identity headers → Agent Server 建立 native Run
  → deepResearcherGraph 的 production resolver 回 undefined
  → 沒有建立 taskId／canonical execution_context
  → searchWeb → invokeTool → GovernanceExecutor
  → resolveExecutionContext → readExecutionContext(production)
  → executionContextSchema.parse：taskId Required
  → authorizeToolDispatch catch → AUTHORIZATION_UNAVAILABLE
  → legacy ToolMessage → synthesis
```

主問題層級：可信 Runtime 入口／ExecutionContext composition，失敗暴露於 Tool Execution 的授權前置。

不是已證實的根因：web_search 未實作、工具清單未註冊、Tavily key 錯誤、上游 Tavily HTTP 授權錯誤。此筆執行在本地 context 建立階段已失敗，沒有證據顯示進入 Tavily dispatch。

第二問題層級：LangGraph State 與 Synthesis／Context Assembly 的跨輪資料選取。完整歷史中的舊工具結果能再次進入目前回答；原對話具有污染條件，新對話沒有該條件。靜態選取路徑已確認，但尚未擷取原輪完整模型 prompt，不能把回答每一句內容都歸因於某一筆舊 ToolMessage。

## 5. 原始碼地圖與連帶缺口

| 位置 | 盤點重點 |
| --- | --- |
| `backend/langgraph.json` | 四個 Graph 的實際匯出入口；HTTP app 與 configurable_headers 設定；沒有 task bootstrap |
| `bff/src/server.ts:555` copyRequestHeaders | 覆寫可信 principal／scope headers；body 經 input／upload 驗證後仍作為上游 body 傳送 |
| `bff/src/server.ts:1169` | HTTP proxy 呼叫點；保持取消、timeout、串流與既有路由語意 |
| `backend/src/agents/deep-researcher.ts:3031` | 最外層 context instrumentation 目前只在 development 且明確 opt-in 時建立 development context；其他情況 resolver 回 undefined |
| `backend/src/runtime/execution-context/instrument-graph.ts` prepareConfig | resolver 回 undefined 即原樣傳 config；有 context 才移除舊 execution_context／x-bff-*、注入 canonical，再執行 identity status／correlation hooks |
| `backend/src/runtime/execution-context/read-execution-context.ts:111` | taskId 只讀合法 alias，不從 runId／threadId 補值 |
| `backend/src/runtime/execution-context/read-execution-context.ts:236` | 最終 executionContextSchema.parse；canonical 若原先存在也會直接 parse，因此 Schema 有效不等於來源可信 |
| `backend/src/runtime/execution-context/execution-context.ts` | 契約已重用 `@gun-ai/harness-contracts`；不可另造平行 Schema |
| `backend/src/tools/authorization/tool-authorization.ts:229` | production 走嚴格 reader；預設 profile 為 production；development 不是免授權／免 DB 模式 |
| `backend/src/platform/tool-governance.ts:458` | context 解析在授權 try 內；缺 context／解析失敗／其他授權依賴錯誤均可能回 AUTHORIZATION_UNAVAILABLE，需分層證據，不能僅靠字串判因 |
| `backend/src/platform/tool-governance.ts:518` | 授權決策須先持久化，才可 dispatch；不可旁路 |
| `backend/src/tools/registry.ts` | 建立 authorization composition、execution profile／secret broker；dispatch pipeline 有獨立 flag，不能假設切換 flag 能修復問題 |
| `backend/src/operations/execution-composition-root.ts:246` | 已有 canonical execution composition，但依賴呼叫者提供含 taskId 的 createCorrelation；在 backend/src 非測試搜尋只見定義，未見連接目前 Graph 匯出的呼叫者 |
| `backend/src/operations/http-app.ts` | operations／health／subject-rights 路由，不是目前 native Run 的 task allocator；不能只因 langgraph.json 設了 http.app 就視為已攔截所有 native routes |
| `backend/src/platform/interaction-runtime.ts:329` | 有限定 legacy 的 taskId ?? runId fallback，但它不是 canonical 注入，也不是允許擴散該 fallback 的依據 |
| `backend/src/runtime/tool-dispatch/task-step-adapter.ts:116` | 先使用既有 context.taskId，再 find/create AgentTask；無法在工具授權前替缺失 taskId 解套；建立與查找存在 concurrency／idempotency 設計需求 |
| `backend/src/runtime/persistence/task-repository.ts` | Task authority 與持久化候選重用點；create 是一般 INSERT，不是可直接當作原子 get-or-create 的現成介面 |

### 5.1 可信傳輸邊界：不能只補 taskId

- BFF 覆寫 HTTP headers 不代表 nested body `config.configurable.execution_context` 或其中的 `x-bff-*` 一定不可偽造。
- 目前 reader 會優先接受 canonical schema；production wrapper 沒有建立新 context 時不會消除客戶端可控 metadata。這是需覆蓋的靜態安全缺口，尚未進行惡意 request exploitation，不宣稱已確認可越權成功。
- 後續要用實際版本驗證 Agent Server 將 HTTP headers 與 body configurable 合併的來源、順序、保留欄位與優先權。不能把剛好叫 x-bff-* 的 config key 當作可信證據。
- 前端不得供應 authoritative taskId、principal、scope 或 execution_context。BFF 可負責 transport sanitation／可信身份映射；Chat-Gun backend 負責 domain Task，不能把 BFF 變成第二套 Agent Runtime。
- `langgraph.json` includes 與 BFF 新身份欄位（principal-kind／account／session／device 等）存在靜態差距；live metadata 又含部分欄位，實際 SDK merge 行為需確認。不要直接全放行 headers 或轉送機密。
- 可信入口接通後 identity-status／memory hooks 可能開始生效；要測合法服務身份、匿名身份、已撤銷 session 等既有規則，不能假設只影響 search。

### 5.2 Tool 子層 correlation：canonical 與 raw alias 脫節

`backend/src/agents/deep-researcher.ts:640` 的 invokeTool 產生 toolCallId，卻只寫入 raw `tool_call_id`／`step_id`。若 Graph 已有 canonical context，reader 會優先取 canonical，新的工具 correlation 不一定被看到。

`backend/src/runtime/tool-dispatch/pipeline.ts:535` 明確要求 canonical stepId 與 toolCallId，缺少會回 `TOOL_EXECUTION_CONTEXT_UNAVAILABLE`。因此只修 Graph taskId 仍可能在啟用 pipeline 時碰到下一關。

此外，現行 step_id fallback 是 nodeName；`task_steps.step_id` 為全表主鍵（migration 002），不能直接把 search_web 之類節點名稱當成跨 task／多 query 的持久化 Step ID。修正方案要區分 node label、logical Step identity、tool call identity 與 attempt；保留工具訊息、span、event、audit 的同一 correlation，不製造兩套 ID。

### 5.3 本輪證據不只一個 filter

| 路徑 | 目前行為／風險 |
| --- | --- |
| DeepResearchState.messages（229） | concat reducer 保留完整對話；本身不等於 bug，但不能整份當本輪工具證據 |
| formatEvidence（2602） | 選取全部 ToolMessage，沒有 task／turn 限制；並納入全部 imageObservations 與 extractedSources |
| synthesizeAnswer（2909） | 同時傳完整 messages 與 formatEvidence 組成的 toolOutputs |
| agents/context-integration.ts assembleAgentContext | 除最新 HumanMessage 外遍歷其餘訊息；舊 ToolMessage 分類到 tool_output，caller 的 toolOutputs 又再加入；只修 formatEvidence 仍會重入、重複計入 budget |
| legacy synthesis branch | getResearchTopic(state.messages) 展平成完整 transcript；state.ts 將非 AI 訊息標為 User，ToolMessage 也可能混入 |
| planResearch（1392） | current question 已取最新 user，但完整 messages／contextPack／累積 imageObservations 仍可進 planner context |
| getLatestToolMessageContent（2627） | 在完整歷史找同名 tool，targeted error／calculator fallback 也需遵守當前證據邊界 |
| validateUploads（718） | 成功時回 {}，不清舊 uploadError；可造成下一輪沿用前輪錯誤分支的靜態風險 |
| 其他 state channels | replacement reducer 只有收到 update 才換值；default 不會在同 thread 每輪自動重設 |

searchWeb（2378）建立 ToolMessage 時 invocation artifact 傳 undefined，僅有 tool_call_id；現有 weather 的 ExecutedToolCall artifact 不能直接視為通用 task／turn provenance。要先定義證據所有權再決定擴充 artifact 或獨立 state projection，不能對 search 假裝已有完整 provenance。

## 6. 候選修正邊界（尚待規格核准）

### A. 可信 Graph entry composition

偏好的責任切分：可信身份 transport → server/native correlation adapter → Chat-Gun Task admission／lookup → canonical Schema validation → Graph instrumentation → Tool child context。

須在 design 解決：

1. requestId／native runId／threadId 來源；使用現有 alias adapter，不在各 agent 散落解析。
2. Task 由 backend domain owner 產生並與 owner／scope、thread、當前邏輯工作綁定；不是隨手 UUID 填上就算完整。
3. 新 prompt 建立新業務 Task；resume／同任務 retry 是否維持 Task identity，依現有 recovery／interaction 契約確認。native resume 可產生新 Run，不可直接按 runId 重設任務證據。
4. 在工具執行與其他受保護依賴前完成 context；若建立／查找失敗，維持 fail-closed。不要等到 TaskStepAdapter.start 才發現缺 Task。
5. 若 allocation 需 async DB I/O，現有 ContextResolver 是同步型別；應在合適的 entry composition／factory 或經核准的 async resolver 邊界接入，不能用 type assertion、背景 Promise 或 process-global currentTask 蒙混。
6. 驗證 Graph 匯出 Proxy 與實際 Agent Server 呼叫方法的相容性；invoke／stream／streamEvents／streamLog、取消 signal、callbacks／tags／metadata 都要保留。
7. 處理 new task、resume、concurrent admission、repeated submit 的原子性與 idempotency，避免重複建立或挪用其他 principal 的 Task；不要重建 native Run queue／worker 系統。
8. 不直接沿用 interaction-runtime 的 taskId=runId legacy fallback 作 canonical authority；檢查同 Task 在 active ownership 與 tool ledger 是否一致，避免雙重 Task。

方案比較：

| 方案 | 評估 |
| --- | --- |
| 共用 backend entry adapter，接入實際註冊 Graph | 優先評估；owner 清楚，可測所有工具路徑；需證明 native Server invoke／stream 接點有效 |
| Agent Server 官方可用的 auth／middleware／graph factory 接點 | 可作 transport origin 保證，但必須先核對本地版本與官方契約、做小型實證；本次未選定或聲稱某 API 可用 |
| BFF 自行生成 taskId 並整段塞 context | 不建議；混淆 domain ownership，resume/idempotency 與 body spoofing 問題未解 |
| 在 readExecutionContext 內自動 taskId=runId | 拒絕；違反既有缺欄位 fail-closed 與 identity 分工 |
| 在工具 handler 內硬補 context／關閉 authorization | 拒絕；太晚，繞過統一邊界與審計 |

### B. 每次工具 dispatch 派生 canonical child context

- 從已驗證的 parent context immutable 派生 stepId、toolCallId、attempt，經現有契約驗證後用 withExecutionContext 合併。
- parent principal／scope／taskId 不由工具 input 或 LLM 改寫。
- 同一 logical call 的 retry、graph node replay、resume 如何重用 ID，須與既有 ledger／idempotency 契約一致；不可單純每次重播產生新的 side-effect identity。
- 覆蓋 pipeline 開／關兩條路徑，保留 legacy ToolMessage 與 structured error 的相容顯示。
- 沒有必要即不改全域 Tool Schema、Graph ID 或公共錯誤碼。

### C. 本輪證據 projection，而非刪除歷史對話

定義「本輪」為邏輯 task／turn，不能等同單一 native Run。新 prompt 要重設該輪工作資料；同一任務 interrupt/resume 要保留已蒐集的有效證據。

候選策略：以可信 Task identity 綁定 turn evidence，明確標示 observation／tool result provenance；完整 messages 仍用於對話顯示，另產生有界的 recent conversation 與 current evidence 輸入。若選擇最新 HumanMessage 邊界作 legacy 遷移，必須處理缺 message ID、相同文字的新問題、resume answer、重複 message、舊 checkpoint，不能只無條件 slice 後就宣稱完整。

最低選取要求：

- planner 的歷史僅用作上下文，不把舊工具資料當本輪查證。
- synthesis／targeted fallback／legacy branch 使用同一當前證據邊界；成功、失敗與重試證據均保留型別化狀態，不靠答案文案推斷。
- assembleAgentContext 不得從原始 messages 再引入已排除的舊 ToolMessage；同一工具內容只按一次預算來源納入，避免 messages + toolOutputs 雙重注入。
- 不任意修改共享 helper 的全域語意。MCP message context 既有測試要求 assistant tool_calls 與 ToolMessage 成對保留／丟棄；新增能力宜由清楚的輸入契約表達，或在 deep researcher 做受測 projection。
- 舊 assistant 回覆可保留為 conversation history，但不能標為本輪 evidence；使用者要求「引用剛才結果」時若允許 reuse，須規格化來源、scope、freshness，而非自動全量歷史重用。
- memory recall 仍走既有授權與 budget；歷史記憶不因本次有 context 就自動變成本輪外部事實證據。

### D. State／Checkpoint 重設與相容性盤點

| Channel 類型 | 目前例子 | 候選 owner／生命週期 |
| --- | --- | --- |
| 對話歷史 | messages | 保留串流與歷史，不因新 task 清空整個 thread；投影選取另做 |
| 每輪研究資料 | plan、searchResults、rankedSources、fetchedSources、extractedSources、verification | 新 prompt 初始化；同 task resume 保留；未走該 node 不能殘留舊值 |
| 每輪輸入／圖片 | uploadError、imageObservations、contextPack | 新輸入清理／重建；imageObservations 現為 concat，回 [] 無法清空，需明確 reducer／分區設計 |
| 工具專項狀態 | weatherExecution、clarification | 新獨立 task 不沿用；澄清 resume 不誤清；遵循 weather 專項規則 |
| 使用者執行設定 | reasoning_model、initial_search_query_count、max_research_loops | 保持既有預設／覆寫規則；不要與證據重設一併任意抹除 |
| 新增任務／證據識別（若採用） | 名稱與 Schema 待 design 決定 | 只存可序列化 ID／資料；定義 default、reducer、owner、舊 checkpoint migration／拒絕策略 |

不要只在 START 節點無條件清空：interrupt resume 不一定重新從 START 執行，重播也不能丟掉同任務成果。不要把 AbortSignal、client、model 或 secret 寫入 state/checkpoint。

## 7. 預計施工觸點與順序

以下是候選影響範圍，不是全部檔案都必須修改；以核准 design 及失敗測試決定最小閉環。

1. `backend/src/runtime/execution-context/`：可信入口 composition／context 派生／instrumentation 與測試；保留嚴格 reader，禁止弱化 missing taskId 測試。
2. `backend/src/agents/deep-researcher.ts` 及相鄰 tests：實際入口接線、Tool child context、本輪 evidence projection、State lifecycle。
3. `backend/src/agents/context-integration.ts` 及 tests：僅在確有必要時增加明確 source selection 契約；驗證其他 agent 不回歸。
4. `backend/src/runtime/persistence/`、`tool-dispatch/task-step-adapter.ts`、`platform/interaction-runtime.ts`：只有 task ownership／原子建立／identity 一致性需要時修改；不得順便重寫持久化系統。
5. `backend/langgraph.json`、`bff/src/server.ts` 及 BFF contract tests：依 transport 來源與 canonical spoofing 驗證決定 sanitizer／可信欄位傳遞，需跨套件契約驗證。
6. `math-agent.ts`、`mcp-agent.ts`：同類 development-only context resolver 已存在，納入 shared boundary 的影響分析；chatbot 未見相同 wrapper。是否同步接線由核准 scope 決定，不擅自改所有 graph。
7. frontend 預設不改；僅驗證既有 route／stream／error display。若新增事件或 state transport 欄位影響公開型別，才依核准契約同步。

適用規格：`openspec/specs/canonical-execution-context/spec.md`、`trusted-tool-authorization/spec.md`、`langgraph-runtime-boundary/spec.md`、`context-assembly/spec.md`。Runtime ownership 背景：`docs/decisions/current-langgraph-runtime-boundary.md`。需進一步對照的領域：interaction ownership、recovery／interrupt manifests、tool scheduling／side-effect identity、memory/data governance。只載入本次必要規格，不掃描所有 Change 或 ignored Runtime Artifacts。

關鍵不變量：production 缺必要 context fail-closed；domain 與 transport 分離；principal／scope 不接受 client authority；Tool decision 先落盤；Task／Run／Thread 身份不混用；native Run/checkpoint 不被另建系統取代；既有 Graph ID／BFF route／錯誤語意保持相容。

## 8. 回歸矩陣與驗收方法

### 8.1 Deterministic／mock integration（均待新增或擴充，尚未執行）

| 案例 | 必須斷言 |
| --- | --- |
| BFF 正常請求沒有 client taskId | 可信入口建立／取得 domain Task；工具拿到完整 canonical context；不是測試直接塞完整 context 掩蓋缺口 |
| task admission／DB／decision store 不可用 | fail-closed、工具 handler dispatch 次數 0、機器錯誤保持可辨識；不冒充 Tavily key failure |
| 缺 trusted identity／缺 native correlation／非法 scope | 拒絕，不以 anonymous／placeholder／runId 自動放行 production |
| 客戶端偽造 nested execution_context／x-bff-*／taskId alias | 無法改變可信 principal、scope、Task 歸屬；含 canonical 與 raw alias 衝突、metadata/configurable 不同位置 |
| 兩個並行 thread／同 thread 競爭／不同 principal | context 不串線；Task admission 原子且有界；scope 不交叉；無全域 currentTask |
| 同 node 多 query／多次 tool call | step identity 不衝突；ToolMessage、event、trace、decision 的 toolCallId 一致 |
| pipeline on／off、execution profile on／off | 相同可信 context 保證；profile off 不等於跳過 secret resolution；不得靠 flag 掩蓋錯誤 |
| cancel／timeout／重試／stream 中斷 | signal 傳到 provider；terminal 不回 running；重試 attempt 與 logical call identity 正確；無不必要重派 |
| 先 weather 後 news，第二輪 search 失敗 | 第二輪模型 prompt 的 current tool evidence 不含前輪 weather；回答保留本輪 search 限制，不引用天氣 |
| 先成功 research 後失敗／direct／calculation | 不沿用上一輪 extractedSources、verification、錯誤或 calculator result |
| 先圖片／upload error 後純文字正常輸入 | 不殘留 imageObservations／uploadError；新問題不因舊錯誤跳過 planner |
| 同 task interrupt/resume／新 native Run | 當前已收集證據保留，Task identity 不漂移；確認與澄清不得重複執行；新 prompt 與 resume 明確區分 |
| 舊 checkpoint 沒有新 provenance | 依核准 migration／bounded compatibility 處理，不默認整份歷史都是 current evidence |
| 重複／亂序訊息、相同問題文字再問一次 | 依結構化 identity 去重／分輪，不靠文字、timestamp 猜測 |
| assembly on／legacy off branch、MCP tool pairs | 所有 synthesis 分支均不重入舊工具；沒有雙重 tool budget；MCP assistant/tool 配對不破壞 |
| 未知 tool result／未知事件／格式錯誤 | runtime validation、明確 fallback，沒有靜默吞錯或硬映射所有失敗 |

建議測試落點：`read-execution-context.test.ts`、`instrument-graph.test.ts`、`propagation.test.ts`、`cross-layer-contract.test.ts`、`tool-authorization.test.ts`、`tool-governance.test.ts`、`pipeline.test.ts`、`task-step-adapter.test.ts`、`interaction-runtime.test.ts`、`context-integration.test.ts`、`deep-researcher.context.test.ts`、`deep-researcher.query-workflow.test.ts`、既有 weather／clarification／recovery tests、`bff/src/server.test.ts`。

目前 deep-researcher.context.test.ts 主要是原始碼存在性檢查（assembleAgentContext 等），不足以證明本輪證據隔離；要補對模型輸入與 persisted multi-turn State 的行為斷言。

### 8.2 Live smoke（後續取得合法執行環境再做）

1. 確認 live process 真正使用修改後目錄、模型與 flags；不輸出完整 environment／configurable／headers。
2. 只記錄 dependency readiness 的狀態與安全錯誤碼：授權 DB／migrations／policy 可用、secret reference 是否可解析。缺依賴先回報，不自動授予權限、不把 development 模式當繞過。
3. 經 BFF 建立新診斷 thread，用原問題測一次；記錄 request/thread/run/task/step/toolCall IDs、授權結果、dispatch status、search result count。
4. 相同 thread 先 weather 再 news；查證第二輪 evidence provenance、錯誤與來源，不只看自然語言回答。
5. 另驗 retry／interrupt-resume 的 context continuity；只做核准範圍內的無破壞性測試。
6. 若 Tavily／模型／DB 不可用，分層列出阻擋；只有真實工具成功才可宣稱 live search 通過。news 內容隨日期變動，不固定斷言某篇頭條。
7. 有可操作瀏覽器才補「研究流程」工具事件與最終回答 UI 檢查；API 通過不冒充 UI 通過。

### 8.3 套件驗證

後續實作至少跑所有受影響套件的現有驗證；先 targeted regression，再完整套件：

```text
backend: npm run lint; npm run test; npm run build
bff: npm run test; npm run build
frontend（若改前端或跨層公開契約）: npm run lint; npm run test; npm run build
git diff --check
```

以執行當下 package.json 為準。本次發現 BFF 已有 test 與 test:node，雖根規則的歷史說明寫「沒有 test script」，不可因此跳過現有測試。BFF test 會涵蓋 Vitest 及 build 後的 Node tests。

## 9. 風險、禁止捷徑與待決策項

- 不放寬 executionContextSchema，不移除 taskId 必填，不將 TASK/Run/Thread identity 混為一談。
- 不把 AUTHORIZATION_UNAVAILABLE 一律解釋成 Tavily key；修好 context 後可能才出現 DB／policy／secret 的下一道錯誤。
- `DATABASE_URL` 與部署使用的 `POSTGRES_URI` 不可假設等價；getPool 的實際讀取配置、授權 tables 與 migrations 要另作安全 preflight，不能直接改真實環境檔案。
- 不預設 existing Operations composition 已服務 native Graph；需證明實際 wiring。
- 不將所有代理 Graph 改成繞過保護的 development reader，不打開所有 headers、不硬編碼 principal／role／tenant。
- 不只改 Prompt「不要提天氣」；污染來源須在 state／evidence selection 層處理，不能用關鍵字過濾代替 provenance。
- 不無條件清空 messages／state，不破壞 resume、歷史顯示、多模態、MCP protocol pairing 與既有 weather clarification。
- 正式部署 persistence、Task admission atomicity、舊 checkpoint migration、Run/Task resume mapping 尚待 design 決策與驗證；不要將本機 dev 的證據升格成正式 Server 保證。
- BFF body spoofing 能否到達可信 reader 尚未 live 攻擊驗證；以安全測試確認，不在使用者真實 thread 注入偽造管理員資料。
- 新增可觀測性僅記錄驗證階段、issue path、錯誤碼與必要 correlation；不保存完整 prompt、credential、原始可信 headers 或敏感 tool input。
- 若兩輪修正仍失敗或 mock 成功而 live 失敗，依根規則停止局部微調，回到同一份 golden evidence 比較，不進行第三輪無證據的補丁。

## 10. 本次完成紀錄

- 完成：根因證據整理、入口與 tool child context 接線盤點、跨輪污染路徑／State lifecycle／回歸矩陣、後續施工 gate 與環境差異保存。
- 修改檔案：僅本筆記。
- 對應 OpenSpec Tasks：尚未建立本議題的核准 Change，沒有勾選任何 Task。
- 測試結果：見第 3.4 節，前段既有 63 tests 通過；本次僅文件，未重跑應用程式測試。
- 尚未處理：程式修正、規格與 gate、可信入口接點實證、PG／secret preflight、完整回歸與 live 修復驗收。
- 建議下一步：使用者要求施工後，從第 1 節續接；先確認目標工作目錄與合法 Change owner，不重新要求使用者貼 API key。
