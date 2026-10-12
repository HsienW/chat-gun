# execution-context-turn-evidence 施工紀錄

日期：2026-10-11。角色：Codex implementer。使用者明確授權本次直接修改，不走 OpenSpec；沒有建立、挪用或勾選其他 Change。

工作目錄：`C:/D/ai-agent/chat-gun`。分支：`feat/4.5.2-fix/execution-context-turn-evidence`。未提交 Git、未部署、未修改憑證或授權政策。

## 完成內容

原始證據與施工盤點見 [web-search-execution-context-inventory.md](web-search-execution-context-inventory.md)。失敗層級為 Backend Graph 可信入口／Tool Execution，以及跨輪 State／Synthesis 證據選取，不是前端顯示或已證實的 Tavily key 錯誤。

- deep_researcher 的 invoke／stream 入口先驗證可信 identity 與 native request/thread/run，再經 PostgreSQL Task admission 建立獨立 taskId，組成 canonical ExecutionContext；不以 runId 冒充 taskId。
- admission 使用既有 agent_tasks.metadata.graphEntry 保存 initialRun、thread、principal、tenant、scope 歸屬；transaction 與同 run advisory lock 保護重複建立。同 native run 重用已建立 Task；resume 必須驗證 checkpoint Task 與持久化歸屬。
- 新使用者輸入於 validateUploads 重設本輪 plan、contextPack、搜尋／來源／verification、圖片／uploadError、weatherExecution 與 clarification。messages 保留供歷史展示。
- State 新增可序列化 executionTaskId，由入口 context 寫入；新輪替換，null／Command resume 保留。同 Task resume 使用新 native runId 但不另建 Task。
- tool child context 保留 principal／scope／Task，依 Task、node、tool 與結構化 input 產生穩定 stepId／toolCallId；相同 logical call 可重播。沒有 canonical context 的 legacy 呼叫保留既有 UUID／node step 行為。
- current tool evidence 只選最新 HumanMessage 之後的工具訊息；planner／synthesis 的 conversation 排除 ToolMessage，避免歷史工具混入或本輪工具重複注入。contextPack／圖片驗證同樣只取本輪；不靠自然語言關鍵字過濾天氣。
- BFF 拒絕 config／configurable／metadata 中偽造的 execution_context、相關 ID aliases、x-bff-*，以及 input／values 注入 executionTaskId。回傳 HTTP 400 與 UNTRUSTED_EXECUTION_CONTEXT，且不送往上游。保留正常訊息內容、模型設定與 native 頂層 thread_id。
- langgraph.json 補齊既有 BFF principal-kind/account/session/device headers 的明確允許清單；沒有全面開放 headers。

## 修改檔案

所有路徑相對上述工作目錄。

| 檔案 | 用途 |
| --- | --- |
| backend/src/runtime/execution-context/graph-entry.ts | 可信入口與 resume binding |
| backend/src/runtime/execution-context/graph-task-admission.ts | PostgreSQL Task admission |
| backend/src/runtime/execution-context/tool-call-context.ts | Tool child context |
| backend/src/runtime/execution-context/instrument-graph.ts | 非同步 context resolver 與可信 task alias 傳遞 |
| backend/src/agents/deep-researcher.ts | 接線、本輪 State lifecycle 與 evidence 隔離 |
| backend/langgraph.json | 可信 header allowlist |
| bff/src/execution-context-boundary.ts、bff/src/server.ts | Client authority spoofing 阻擋 |
| backend/src/runtime/execution-context/graph-entry.test.ts | 入口、resume、並行隔離、取消與 fail-closed |
| backend/src/runtime/execution-context/graph-task-admission.test.ts | Task 歸屬／重複 admission／rollback／依賴失敗 |
| backend/src/runtime/execution-context/tool-call-context.test.ts | Child context 穩定性及 legacy 相容 |
| backend/src/agents/deep-researcher.turn-evidence.test.ts | 真實 compiled Graph checkpoint 與模型輸入行為 |
| backend/src/agents/deep-researcher.query-workflow.test.ts | State fixture 補齊 executionTaskId |
| bff/src/execution-context-boundary.test.ts、bff/src/server.test.ts | 保留欄位與 HTTP 邊界回歸 |
| docs/investigations/ 兩份本議題文件 | 調查與施工交接 |

沒有修改 frontend 原始碼、套件版本或 lockfile。未新增或執行資料庫 migration。

## 對應 OpenSpec Tasks

不適用：依使用者本次明確豁免施工。沒有宣稱 OpenSpec 驗收或變更生命週期已完成；原盤點矩陣中未執行的 live 項目仍待驗證。

## 測試與驗證結果

### 修正前後的證據

- 模型輸入 golden case：修正前 assembly on／off 兩例皆可觀察 OLD_WEATHER_EVIDENCE 混入；修正後均排除，CURRENT_SEARCH_FAILURE 僅出現一次。
- BFF HTTP case：修正前偽造巢狀 execution_context 被送往測試上游並取得 200；修正後 400，且上游呼叫數為零。
- 新增 actual compiled Graph 測試：seed 舊訊息、uploadError、圖片與 Task；新輸入經 START 重設、pause 後 null resume 仍保持新 Task，模型輸入無舊工具標記。Task admission 與 LLM 為 mock，Graph／MemorySaver 實際執行，不能等同 Agent Server 或 PostgreSQL live。
- 完整回歸曾揭露 legacy toolCallId／stepId 相容性差異；已比較原 invokeTool 分支並完整保留舊行為，既有 weather／tracing assertion 未放寬。最後完整回歸結果如下。

| 套件 | 實際命令 | 結果 |
| --- | --- | --- |
| backend | npm test -- --silent | 234 files、1,619 tests 通過；6 files、46 tests 跳過 |
| backend | npm run lint | 通過，含 22 份 additive migration 檢查及 TypeScript |
| backend | npm run build | 通過 |
| bff | npm test | 16 Vitest files、122 tests 通過；另 9 Node tests 通過 |
| bff | npm run build（由 test:node 執行） | 通過 |
| frontend | npm run lint | 通過，badge.tsx／button.tsx 兩項 Fast Refresh warning |
| frontend | npm test -- --silent | 22 files、178 tests 通過 |
| frontend | npm run build | 通過；既有 bundle 超過 500 kB 警告，未修改前端程式 |
| repository | git diff --check | 通過 |

各套件以既有 lockfile 執行 npm ci，未升級依賴。Windows 沙箱曾阻擋 Vitest 暫存檔 rename，測試以核准的提升權限重跑。npm 提示既有 user config 與部分 install-scripts 警告，未擅自更改設定。

## 尚未處理事項

- 沒有啟動修改後的 native Agent Server 或重啟原服務。原調查中的 5173／2024 程序來源為另一份 chat-gun-react-agent checkout，不能宣稱它已取得本次改動。
- 未執行真實 PostgreSQL transaction／同 run 競爭／跨 run resume 整合；admission SQL 使用 fake connection 測試。未驗證 DB schema、授權資料與 Tavily secret readiness。
- 未完成 native Server 對 Graph 的 configuration／checkpointer 包裝與部署持久化驗證；目前證據限直接 exported Graph invoke、stream instrumentation 及 MemorySaver checkpoint。部署前需經原 BFF→Server 路徑驗證，包含 Server 複製／配置 Graph 時是否保留入口與 checkpoint owner。
- 未執行真實模型、Tavily web_search、UI「研究流程」、端到端取消／timeout／retry。46 skipped tests 不視為通過。
- 本次 admission 僅建立與驗證 Task binding，未擴張成完整 Task terminal lifecycle manager；不宣稱 admission 的 created 狀態代表整個 Graph lifecycle 已同步。
- 新 JSON metadata run lookup 尚無專用 expression index；DB connection、lock 等待與部署 timeout 需實際驗證。現有 migration registry 與第 022 份 migration 的註冊差異未混入修正。
- evidence 輪次邊界使用訊息角色／順序，而非完整逐項持久化 provenance schema；保留歷史 human／AI 對話，不承諾模型永遠不提及歷史回答。未全面驗證任意訊息重排、手工匯入或跨 Task 重播。

## 相容性與風險

- Graph ID 與 BFF routes 不變；新增 executionTaskId 與保留欄位的 400 錯誤。依賴偽造保留 ID 的客戶端會被拒絕，這是刻意收緊的信任邊界。
- 舊 checkpoint 缺 executionTaskId 時，resume fail-closed；不偷偷另建 Task 接續舊操作。應新開請求或另行設計有歸屬驗證的遷移，未實作自動遷移。
- production 缺可信 identity、native correlation 或 Task persistence 時即拒絕，不以 anonymous、固定 ID 或關閉 policy 補救。development 僅沿用原有明確雙旗標入口，仍需 Task persistence。
- getPool 依賴 DATABASE_URL；不假設 POSTGRES_URI 可替代。需既有 agent_tasks 及授權／interaction 所需 schema。未讀取或輸出 API key。
- Runtime 仍須置於可信 BFF／Server 邊界之後；沒有新增公開直連 Runtime 的身份驗證能力。完整 context 未寫入 checkpoint，只保存 Task ID。
- 修正 context 後仍可能出現 policy、secret、DB 或 provider 的下一道錯誤；本報告不等同 web_search 已成功。

## 建議下一步

1. 在正確 checkout 啟動隔離測試服務，安全確認 DB／policy／secret readiness，不輸出設定值、不自動授權。
2. 經 BFF 重播原新聞問題及同 thread「weather→news」，記錄安全 correlation、tool status／errorCode 與來源數。
3. 補 native Server 的 streaming、Graph configuration、持久化 checkpoint resume 與 DB 並行／取消驗證；若入口包裝未被保留，先固化該失敗再修正。
4. 只有真實工具成功及 UI 事件驗證後，才能宣稱原服務修復與部署驗收完成。

## 2026-10-12：BFF 誤擋合法 client metadata 回歸修正

- 問題重現：在 `http://localhost:5173/app/` 新對話輸入「請只回答：連線測試」，UI 出現 `langgraph_stream / unknown_error / HTTP 400 / UNTRUSTED_EXECUTION_CONTEXT`。這次錯誤發生在 BFF，尚未進入 Graph／Tool 授權。
- 根因：`hasReservedConfig` 遞迴依欄位名稱拒絕所有 `requestId`／`runId`，沒有區分 canonical authority 與既有 `config.configurable.clientInteractionMetadata.requestId`／`activeRunHint.runId`。前端每次 submit 都產生前者，後續互動可能包含後者。前次合法案例只測 inputKind，漏掉實際必要欄位，屬本次提交引入的回歸。
- 修正：僅在精確的 client metadata 物件及其 activeRunHint 物件中容許字串追蹤欄位；不複製到 canonical execution_context、不提升權限、不全面跳過 metadata 掃描。其他位置的同名欄位，以及 metadata 內夾帶 taskId、execution_context、x-bff-* 或巢狀偽造內容，仍拒絕。格式與 input kind 的既有驗證責任不變。
- 變更範圍：`bff/src/execution-context-boundary.ts`、同名 test、`bff/src/server.test.ts` 與本文件。沒有更動 frontend、backend、認證政策或環境設定。沿用本議題直接施工授權，無 OpenSpec Task 更新。
- 先紅後綠：新增案例在修正前得到 5 failed／134 passed，包含 HTTP 400 而非預期 200；修正後 `npm test` 全部 139 Vitest tests 與 9 Node tests 通過，test:node 內含 TypeScript build 通過。`git diff --check` 通過。backend／frontend 本輪未重跑，因本次僅恢復既有 BFF transport 契約，未修改其程式。
- 安全回歸涵蓋四種 inputKind、batch、active run hint、巢狀偽造、錯誤位置與 array metadata；HTTP 測試確認 body 原樣透傳，body requestId 不覆蓋 HTTP request header 的可信 correlation。
- 程序比對：5173 frontend 及 2024 backend 仍使用 `C:/D/ai-agent/chat-gun-react-agent`；8787 程序僅識別到相對入口 dist/server.js，未確認其 working directory。此次修正位於 `C:/D/ai-agent/chat-gun`。未擅自停止程序、寫入另一份 checkout 或宣稱線上 UI 已修復。
- 待續：將修正套用到實際 BFF、重新 build／啟動後，經同一頁面重測；若進入下一道 DB／Graph 錯誤，另依結構化證據定位，不混同這個已重現的 400 回歸。
