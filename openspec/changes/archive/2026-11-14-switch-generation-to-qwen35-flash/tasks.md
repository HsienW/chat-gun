## 0. 前置 Gate

- [x] 0.1 Qwen 完成 review-plan，Blocker 清零，Major 已修正或有明確接受理由。驗證：review-result-review-plan-003 由 adapter 保存（APPROVE，evidence gate 通過，0 Blocker／0 Major），CCR 仲裁兩個 Minor 並寫入 design 與本檔 2.2、2.3。
- [x] 0.2 Master 定案 design 的 OD-1、OD-2、OD-3 並寫回 design（2026-11-04 已定案寫回：OD-1 (a)、OD-2 `LLM_THINKING_DEFAULT_ENABLED`、OD-3 (a)）；`openspec validate switch-generation-to-qwen35-flash --strict` 通過。驗證：design 不再有未定案的 OD；validate 輸出寫入 evidence。Codex 已執行 strict validate 並保存 evidence。
- [ ] 0.3 Group B 施工前檢查（依 OD-1 (a)，以檔案為單位，見 design「Gate 以檔案為單位」）：每個 Group B task 施工前，以 `git status --porcelain` 與 `git diff --stat` 只檢查該 task 要修改的檔案沒有其他 Change 的未提交修改。驗證：每個 task 的命令輸出寫入 implementation_result 的 evidence；某 task 的檔案不乾淨時，只跳過該 task 與依賴它的 task，在 blockers 寫明檔案與原因，其他 task 照常施工。所有 Group B task 都通過各自的 Gate 後才勾選本項。（Archive 說明：程序偏差已於 readiness-result-001／003 接受。）

範圍限制：MUST NOT 修改各 graph 檔案（`chatbot`、`deep-researcher`、`math-agent`、`mcp-agent`、`shopping-assistant/` 下除模型設定以外的檔案）、`backend/src/demo/**`、`backend/src/platform/usage/**`、`backend/src/application.ts`、bff、frontend、embedding 與 rerank 設定、`demo-cost-and-access-guard` 的單價 fixture，以及 `backend/data/**/results/**`。不重跑評測。

## 1. Group A：不重疊的檔案

- [x] 1.1 更新 `.env.example`：所有生成用途的範例值改為 `qwen3.5-flash`（含 vision、legacy 別名）；新增 `SHOPPING_ASSISTANT_MODEL`、`SHOPPING_ASSISTANT_THINKING_ENABLED=false`、`LLM_THINKING_DEFAULT_ENABLED=false`、`KB_EVAL_GENERATION_MODEL` 的範例或註解；`QWEN_BASE_URL` 保留北京，並加註新加坡 endpoint 與「API Key 依區域分開」；embedding、rerank、judge 不變。對應 Requirement：「預設生成模型為單一來源的 qwen3.5-flash」「回滾只需改設定」。驗證：新增測試讀取 `.env.example`，斷言生成用途的值都是 `qwen3.5-flash`、不含任何非空憑證、embedding 與 rerank 鍵值與變更前相同；`cd backend && npx vitest run <新測試檔>`。
- [x] 1.2 評測 invoker 包裝層（新檔，位於評測模組內）：收集每次回應的 provider 回報模型與實際送出的 thinking 值，不改變回傳內容。對應 Requirement：「評測記錄 provider 實際回報的模型」。驗證：有回報、未回報（`unreported`）、回報與設定不同、中途 provider 錯誤、取消的單元測試。（apply-change-001 已交付包裝層與單元測試；改讀 `provider_model` 與 `partial` 狀態移至 2.7，2.7 完成後一併勾選。）
- [x] 1.3 商務鏈評測與訂單請求 golden：建立模型時套用 Gun Shop 的 thinking 設定；provenance 新增 `generationModels`、`observedProviderModels`（含狀態）、`thinkingEnabled`、`llmProvider`、`llmEndpointHost`；報表加一行模型摘要；舊 provenance 讀取相容。對應 Requirement：「評測 provenance 記錄生成模型、thinking 與 endpoint」「live 評測的模型設定與 production graph 一致」。驗證：fake provider 測試斷言每個請求的 thinking 設定與 provenance 欄位；endpoint 含 query 或使用者資訊時只寫主機名稱；舊 `run.json` 重評分讀取通過；`cd backend && npx vitest run src/evaluation/commerce`。（apply-change-001 已交付；`llmEndpointHost` 改用 D-9 查詢移至 2.7，2.7 完成後一併勾選。）
- [x] 1.4 新加坡 endpoint live probe（新檔，預設跳過，以獨立旗標啟用）：逐項驗證 text、json_object（通過 Runtime Validation）、tool_calling、vision（合成小圖）、thinking_off；結果寫入 evidence；不含金鑰或回應全文。對應 Requirement：「新加坡國際 endpoint 相容性以手動 live probe 驗證」。驗證：旗標未設定時跳過且不發出網路請求的測試；以 fake HTTP 驗證單項失敗、逾時、缺憑證、取消的分類測試。live 執行由 Master 決定時機，未執行時在 implementation_result 標示「live 未驗證」。

## 2. Group B：重疊檔案（依 OD-1 與 0.3）

- [x] 2.1 LLM Gateway 預設模型：Qwen 的程式預設（含 vision）改為引用單一 Domain Constant `qwen3.5-flash`；解析優先序不變。對應 Requirement：「預設生成模型為單一來源的 qwen3.5-flash」。驗證：五個用途在未設定時都解析為 `qwen3.5-flash`；設定值優先；legacy 別名仍有效；既有 `backend-model-runtime` 測試不放寬。施工時一併把 D-10 常數（apply-change-002 宣告為 `: string`）改為保留字面值型別，並附型別測試或編譯期斷言（CCR 仲裁 apply-change-002 的 Minor）。
- [x] 2.2 LLM Gateway thinking：provider capability 新增 `supportsThinkingControl`（qwen 為 true，其餘為 false），既有的 thinking 控制查詢改為讀 capability；新增全站 thinking 預設設定 `LLM_THINKING_DEFAULT_ENABLED`（只接受 true／false，未設定為 false，格式錯誤拒絕啟動）；支援的 provider 在每個生成請求都明確送出 thinking 值（含 vision、json_object、Tool、provider 重試、Tool 參數修復重送）；不支援的 provider 不送出，明確要求開啟時拒絕啟動；`response_metadata` 記錄實際送出的值。對應 Requirement：「Qwen 生成請求明確送出 thinking 設定且預設關閉」「不新增模型層 fallback，provider 層 fallback 語意不變」。驗證：以 fake fetch 斷言每種請求的 body；優先序（呼叫端 → 入口預設 → 全站 → false）；ccr 與 openai-compatible 不送出；重試與修復重送帶相同值；取消不重試；啟用 provider 層 fallback 時各 provider 依 capability 決定；五個已註冊 graph 各一個 fake provider run，所有生成請求的模型為 `qwen3.5-flash` 且 thinking 為關閉、embedding 與 rerank 模型不變；同一組 fake 回應下 flash 與 qwen3.7-plus 的 Graph 輸出 Schema 相同；「Schema 相同」以 spec「模型切換不改變 Domain Contract」Scenario 為基準，即 Graph 輸出、Tool 輸入輸出、事件與錯誤碼的 Schema 都相同。依 design D-2 第 6 點，把 `backend/src/platform/llm-gateway.usage.test.ts`「sends the declared Qwen thinking option…」中「未傳 thinking 時不送出」的斷言更新為期望 `enable_thinking: false`（測試名稱可同步更新），該檔其他斷言不得修改；完整 `npm run test` 通過後才勾選本項。
- [x] 2.3 Gun Shop 模型設定：thinking 只接受未設定或 `false`，未設定時有效值為關閉且不受全站預設影響；設定讀取的回傳型別中 thinking 為必填 boolean，未設定時回傳 `false`；`true` 或其他值拒絕啟動，錯誤碼 `invalid_configuration:SHOPPING_ASSISTANT_THINKING_ENABLED`；適用所有模式。對應 Requirement：「Gun Shop thinking 一律關閉並在啟動時驗證」。驗證：回傳型別沒有可選的 thinking 欄位（型別測試或編譯期斷言）；未設定且全站預設為開啟時 Gun Shop 請求仍為關閉；非 demo 模式設定 `true` 拒絕；格式錯誤拒絕；live 評測在建立模型前失敗；`demo-cost-and-access-guard` 的 demo 檢查測試仍通過且未修改。
- [x] 2.4 kb-eval CLI（前置：只需 kb-eval CLI 乾淨；Domain Constant 放在 D-10 的新模組，不必等 Gateway）：生成模型的程式預設改為引用同一 Domain Constant；provenance 新增與 1.3 相同的欄位並使用 1.2 的包裝層；judge 模型與預設不變。對應 Requirement：「評測 provenance 記錄生成模型、thinking 與 endpoint」「評測記錄 provider 實際回報的模型」。驗證：provenance 欄位測試；`--no-judge` 時 judge 欄位語意不變；dataset 驗證失敗仍在建立模型前失敗（不放寬 `harden-kb-evaluation-baseline` 的既有測試）；`cd backend && npx vitest run src/knowledge/evaluation`。endpoint 主機與 `provider_model` 的接線由 2.7 完成。
- [x] 2.5 LLM Gateway `provider_model`（D-8，前置：Gateway 乾淨）：每個 provider adapter 的生成回應 metadata 新增 `provider_model`，provider 回報非空模型名稱時為該值，否則為 `null`；`model` 的既有代填語意不變。對應 Requirement：「Gateway 回應 metadata 區分 provider 回報的模型」。驗證：以 fake fetch 測試有回報、未回報（`model` 為設定模型）、空字串（`provider_model` 為 `null`，`model` 保留空字串，依 spec「provider 回報空字串模型」）、重試與 Tool 參數修復重送後取最終回應；既有讀取 `model` 的測試（含 `demo-cost-and-access-guard` 帳本測試）不修改且通過；各 provider adapter（qwen、openai-compatible、ccr）各至少一案。CCR（Anthropic Messages）adapter 目前沒有 `response_metadata`，必須補上 `provider`、`model`（相同代填語意）與 `provider_model`，`model` 以 Runtime Validation 讀取，不使用 Type Assertion（review-plan-004 Minor 1）。
- [x] 2.6 LLM Gateway 有效 endpoint 唯讀查詢（D-9，前置：Gateway 乾淨）：回傳 `{ provider, endpointHost }`，含內建預設；只含主機名稱；格式錯誤回報穩定設定錯誤且不含設定值；需要 base URL 但未設定的 provider 依既有語意報錯；不加入 `describeLlmGatewayConfig()` 或 health／readiness 回應。對應 Requirement：「Gateway 提供有效 endpoint 主機的唯讀查詢」。驗證：未設定 base URL、含使用者資訊與 query、格式錯誤、缺少必要 base URL 的單元測試；斷言錯誤訊息不含設定值與憑證；health／readiness 既有測試不變。
- [x] 2.7 評測接線改用 D-8、D-9（前置：2.4、2.5、2.6 完成）：包裝層只讀 `provider_model`，缺少欄位視為未回報，新增 `partial` 狀態；kb-eval、chain-eval、order-request golden 的 `llmEndpointHost` 改用 2.6 查詢，查詢失敗時在建立模型與寫入結果前失敗。對應 Requirement：「評測記錄 provider 實際回報的模型」「評測 provenance 記錄生成模型、thinking 與 endpoint」。驗證：以真實 Gateway 搭配 fake fetch 的端到端測試涵蓋 `reported`、`unreported`、`partial`，並斷言代填的 `model` 不會列入集合；未設定 base URL 時記錄內建預設主機；endpoint 設定無效時在寫入前失敗；舊 `run.json` 讀取相容仍通過；`cd backend && npx vitest run src/evaluation src/knowledge/evaluation`。完成後一併勾選 1.2、1.3。

## 3. 整合驗證

- [x] 3.1 backend 完整驗證：`cd backend && npm run lint && npm run test && npm run build`。如實記錄失敗；若失敗在不含本 Change 的基準上也能重現，附基準比對 evidence；不得刪除或放寬既有 Assertion。已知既存失敗（design「apply-change-001 仲裁紀錄」）：`runtime/tool-dispatch/pipeline.test.ts` 錯誤碼不符、`runtime/__tests__/integration.test.ts` 需要 PostgreSQL；兩者在基準上重現時不阻擋本項，但必須附基準比對 evidence；出現其他新失敗時本項不得勾選。基準建立方式（review-plan-004 Minor 2）：以 `git worktree add <暫存目錄> <基準 commit>` 建立獨立工作樹，或把基準檔案複製到暫存快照目錄，在其中執行同一組測試並比對失敗清單；MUST NOT 使用 `git stash`、`reset` 或 `checkout` 改動目前工作目錄。evidence 記錄基準 commit、建立方式與兩邊的失敗清單。
- [x] 3.2 回滾驗證：把 purpose 專屬模型設定改為 `qwen3.7-plus`，執行 2.2 的五個 graph fake run，斷言所有生成請求模型為 `qwen3.7-plus` 且 thinking 仍明確送出。驗證：測試或命令輸出寫入 evidence。
- [ ] 3.3 （Master 決定時機）以新加坡帳號執行 1.4 的 live probe，保存 evidence。驗證：evidence 含 endpoint 主機、模型、日期與五項結果；未執行時，在 implementation_result 的 `notExecuted` 列出，且不得勾選本項。（Archive 說明：live 未驗證；Master 2026-11-14 決定先 archive，執行時機由 Master 決定。）
- [x] 3.4 `openspec validate switch-generation-to-qwen35-flash --strict` 通過。（apply-change-001 曾通過；plan 於 2026-11-07 修訂後需重跑，因此取消勾選。）

## 4. 交付給下游（不在本 Change 內實作）

- 1B-2：以 flash 重跑 `knowledge:evaluate`、`commerce:evaluate`，發布 qwen3.7-plus 對 qwen3.5-flash 比較，訂定並套用 C1 門檻與 fallback 模型。
- `demo-cost-and-access-guard` 6.4(a)：把 `qwen3.5-flash` 的新加坡核實單價填入 demo 單價表；6.4(c) 在本 Change 完成後勾選。
- 1B-6：以 flash 量測每輪實際 token（E3）。

## 本輪實作紀錄（apply-change-001）

- 0.3：檢查已執行但 Gate 未通過；Gateway 與 model-settings 有既存未提交修改，2.1–2.4 與 3.2 未施工／未執行。
- 1.2：包裝層與單元測試已交付；現有 Gateway 在 provider 未回報 model 時仍代填設定模型，無法由 metadata 分辨，因此端到端「unreported」尚未完成，保留未勾選。
- 1.3：商務模型工廠、thinking 關閉、provenance、報表與新舊 run.json 重評分相容已交付並測試；仍依賴前述 Gateway 模型來源問題。未明確設定 endpoint 時，Gateway 內建預設無公開的主機讀取介面，llmEndpointHost 暫為空字串；需 CCR 協調後續範圍，保留未勾選。
- 3.1：完整測試存在兩項失敗，隔離基準亦重現：Tool Dispatch 錯誤碼不符、PostgreSQL 127.0.0.1:5433 ECONNREFUSED；未修改相關 Assertion。
- 3.3：依 Master 指示未執行；新加坡 endpoint live 未驗證。
## 本輪實作紀錄（apply-change-002）

- 0.3：逐檔 Gate 已執行。Gateway（2.1、2.2、2.5、2.6）及 Gun Shop model-settings（2.3）仍有其他 Change 未提交修改，未施工；kb-eval CLI 與相鄰報表乾淨，施工 2.4。未滿足全部 Gate，因此 0.3 保留未勾選。
- 2.4：新增 platform/generation-model-profile.ts 的單一預設生成模型常數，kb-eval 引用它；接入既有評測 observer，新增 provenance 與報表摘要。judge 與 --no-judge 語意維持不變，dataset preflight 仍先於建立模型與結果寫入。knowledge/evaluation 共 85 項測試通過，lint、build 通過。
- 2.7：因 2.5、2.6 尚未完成而跳過；provider_model／partial 與有效 endpoint 主機的端到端驗收仍未完成，1.2、1.3 保留未勾選。本輪不重做 Group A。
- 3.1：基準 commit c998f1eb5f7b84affe4d4623f3de191a5234f25c，以暫存本機依賴閉包快照保留其他 Change；72 檔且不含本 Change 的評測檔案。基準與最終完整測試都只有既有兩項失敗（pipeline 錯誤碼、PostgreSQL ECONNREFUSED）。最終完整測試 2353 通過、2 失敗、117 跳過，依本 task 的既存失敗例外完成，不代表全數測試通過。
- 首輪完整測試另有 usage 測試 5 秒逾時與後續帳本斷言失敗；未修改其 timeout、程式或 Assertion。該檔單獨重跑 12 項通過；不與 lint/build 並行的完整重跑沒有再現，兩輪輸出均保存在 002 evidence。
- 3.2：因 2.2 未施工而未執行。3.3：依 Master 指示未執行；新加坡 endpoint live 未驗證。未啟動 Qwen／adapter、未重跑評測、未 commit／切換分支／stash／reset。

## 本輪實作紀錄（apply-change-003）

- 本輪未修改任何程式碼或測試，未新增勾選。以 partial 交回 CCR（plan-change），請先仲裁以下 Gate 與契約衝突。
- 2.1 Gate：Gateway 乾淨，但 `backend/src/platform/generation-model-profile.ts` 為未追蹤檔案（`??`）。依本輪「檔案不乾淨即跳過該 task」指示，未修改 D-10 常數或 Gateway 預設。該檔為前輪交付，請 CCR 明確處理本 Change 自有未提交檔案的承接規則。
- 2.2 Gate 通過（Gateway、runtime-config 與預定新測試檔乾淨）；尚未寫入前發現 D-8 契約衝突，依 AGENTS.md 與 onConflict 停止施工，非因 Gateway 被占用。
- 2.5 契約衝突：spec「provider 未回報模型」將空字串與缺少欄位合併，要求既有 `model` 代填設定值；但 Gateway 現行 `typeof parsed.model === "string"` 保留空字串。fake fetch 搭配真實 Gateway 重現：要求 configured-fixture、回報空字串，metadata.model 仍為空字串。這與「既有 model 值不變」無法同時成立，待 CCR 仲裁。
- 2.2、2.3、2.5、2.6 因契約衝突停止而未施工；2.7、1.2、1.3 與 3.2 依賴未完成，0.3 未通過全部 Gate。未施工 task 的其餘專項測試未執行。
- 3.1：lint、build 通過。首次完整 test 因 sandbox 暫存目錄 rename EPERM，310 檔載入失敗、未執行測試；只將子程序 TEMP/TMP 改至本 Change 暫存目錄後，以相同 npm run test 重跑，296 檔通過、14 檔跳過，2379 項通過、118 項跳過，exit 0。本次未重現既有 pipeline 錯誤碼或 PostgreSQL ECONNREFUSED。未修改任何測試或 Assertion。
- 3.3：live 未驗證；未啟動 Qwen／adapter、未重跑評測 CLI、未 commit／切換分支／stash／reset／checkout。Gateway SHA-256 前後相同，未觀察到外部修改。

## 本輪實作紀錄（apply-change-003，CCR 接手，Master 授權 auth-switch-generation-ccr-takeover-003）

- CCR 仲裁 Codex 的兩項回報：(1) `generation-model-profile.ts` 為本 Change 前輪交付的未追蹤檔案，不屬其他 Change，Gate 視為通過；(2) 2.5 的 spec 矛盾成立（空字串時 `model` 代填與「既有 `model` 值不變」衝突），2.5、2.7 暫停，待回 PLAN_DRAFT 修正 spec。
- 2.1：D-10 常數改為 `as const` 字面值型別，附編譯期型別斷言；Qwen 五個用途（含 vision）程式預設改引用該常數；優先序、legacy 別名測試通過。
- 2.2：程式與測試已完成（capability、`LLM_THINKING_DEFAULT_ENABLED`、每個 Qwen 請求明確送出、重試與修復重送同值、不支援 provider 不送出並於啟動拒絕開啟、`thinking_enabled` metadata、取消不重試、fallback 依 capability）。未勾選：完整測試中 `platform/llm-gateway.usage.test.ts`（demo-cost-and-access-guard 已提交）斷言「未傳 thinking 時不送出 enable_thinking」，與本 Change spec「每一個生成請求明確送出」直接衝突；該檔不在本 Change 範圍，未修改，待 Master 決定。
- 2.3：Gun Shop thinking 型別改為必填 `false`；`true`／其他值以 `invalid_configuration:SHOPPING_ASSISTANT_THINKING_ENABLED` 拒絕，不受全站預設影響；全站預設開啟時 Gun Shop graph 請求仍為關閉（graph fake run）。
- 2.6：新增 `getEffectiveLlmEndpoint()`；內建預設、含使用者資訊／port／query、格式錯誤、缺少 base URL 與不出現在 `describeLlmGatewayConfig()` 的測試通過。
- 3.2：五個 graph fake run 與回滾測試（`generation-model-graphs.test.ts`）通過；依賴 2.2，未勾選。
- 驗證：lint、build exit 0；strict validate 通過；完整 test 2414 passed、1 failed、118 skipped（唯一失敗為上述衝突，非既存基準失敗）。施工前未逐 task 保存 2.3、2.6 的 Gate 命令輸出（沿用 Master 2026-11-11 提供的 git status 與 Codex 2.1、2.2 Gate），屬程序偏差，已記錄於 implementation_result。
- 0.3 因 2.5 未施工仍未勾選。3.3 live 未驗證。未 commit、未切換分支。

## 本輪實作紀錄（apply-change-004，CCR 接手，Master 授權 auth-switch-generation-ccr-takeover-004）

- 開始前 strict validate 通過（validate-before-004）；Gate（gate-004）只見本 Change 自有檔案，Gateway 無 stream-chat-answer-text 修改。
- 2.2：依 design D-2 第 6 點，把 `llm-gateway.usage.test.ts` 該測試的名稱與「未傳 thinking 時不送出」斷言更新為期望 `enable_thinking: false`；該檔其他斷言（含帳本金額）未修改。完整測試通過後勾選。
- 2.5：OpenAI-compatible／Qwen 與 CCR adapter 新增 `provider_model`（非空字串才保留，否則 `null`）；`model` 完全維持現行行為（字串含空字串原樣保留）；CCR adapter 補上 `provider`、`model`、`provider_model`，以 Runtime Validation 讀取。測試涵蓋有回報、缺少、空字串、重試與 Tool 參數修復重送取最終回應、OpenAI-compatible、CCR；非字串 model 由既有 envelope 驗證拒絕，不會進入 metadata。
- 2.7：評測包裝層只讀 `provider_model`，新增 `partial`；kb-eval 與 commerce（chain-eval、order-request golden 共用 `createCommerceGenerationModels`）改用 `getEffectiveLlmEndpoint()`，查詢失敗時在建立模型與寫入結果前失敗。真實 Gateway 搭配 fake fetch 的 `reported`／`unreported`／`partial` 測試通過，代填 `model` 不列入集合；未設定 base URL 時記錄內建預設主機。完成後勾選 2.7、1.2、1.3。
- 3.2：`generation-model-graphs.test.ts` 在 2.2 驗收後勾選。
- 3.1 重跑：lint、build exit 0；完整 test 2431 passed、118 skipped、0 failed，exit 0。結束後 strict validate 通過。
- 0.3 未勾選：2.3、2.6 施工前未逐 task 保存 Gate 命令輸出（apply-change-003 程序偏差），交由 review-result 與 readiness-check 判斷。3.3 live 未驗證。未 commit、未切換分支。

## 本輪實作紀錄（apply-change-005，Codex Primary Implementer，attempt 2）

- 承接 handoff-apply-change-005，開始時取消 2.2 勾選；補足 readiness-result-001 的 DOMAIN_CONTRACT_EVIDENCE_GAP 後，通過本輪完整驗證才重新勾選。
- 只擴充 generation-model-graphs.test.ts：mcp_agent 接收相同 fake tool_calls，經真實授權、physical_dispatch 與 calculator_tool 執行，比較實際 Tool 參數、結果與第二次 provider 請求的 ToolMessage 結構；持久層與 provider 使用替身。
- 以已註冊 graph.stream 收集 updates／custom；實際觀察 4 個 updates（call_model → authorization_gate → physical_dispatch → call_model），比較雙模型的事件順序與全部 payload 結構。
- 相同格式錯誤 provider 回應經 chatbot graph.stream 產生真實 ProviderResponseParseError，比較完整 own-property envelope 結構及 code=llm_response_json_parse_failed、errorCode=JSON_DECODE_INCOMPLETE。跨模型只比較結構與錯誤碼；各自的 fixture assertion 確認執行及模型設定。
- 新增後測試檔 8 項通過（含 2 項新案例）；lint、build、strict validate 均 exit 0。完整 test 首輪：298 檔通過、14 檔跳過；2433 passed、118 skipped、0 failed，exit 0。未出現 usage 逾時或帳本金額失敗，因此未觸發完整重跑；完整輸出保存於 test-005.txt。
- 未發現雙模型契約差異；未修改產品程式、其他 Change 測試、timeout 或既有 Assertion。0.3 程序偏差與先前 Qwen Minor、歷史 flaky test 紀錄保留；3.3 live 未驗證，未啟動 Qwen／adapter、未重跑正式評測、未 commit／切換分支／stash／reset／checkout。
- 交回 CCR 安排新的 readiness-check；本輪不執行撰寫者驗收，implementationVerified／readinessConfirmed 仍為 false。
