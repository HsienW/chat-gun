# Proposal：commerce-assistant-and-approved-side-effects

## 變更摘要

本 Change 對應 `second-stage-plan-en-v6.md` 的 **X43**，並依 `second-stage-plan-en-v7.md`（Business-Chain-First）調整範圍與證據時程，屬 Second Stage — Layer 9.5（Capability Fast Lane）。

- Labels：`fast-lane`、`layer-9-5`、`retrieval`、`productization`、`backend`、`frontend`、`security`、`reliability`、`evaluation`、`observability`。
- 依賴：X14 unified dispatch、X20 durable HITL、X42 `governed-knowledge-retrieval-and-evaluation`（已封存於 `openspec/changes/archive/2026-10-23-governed-knowledge-retrieval-and-evaluation/`）；第 8 版起另依賴 `@gun-ai/harness-contracts` 新版（新增去重結果類型，Master 自有套件，在 harness repo 修改並發布，design §6.12、tasks TH）。
- Base：v7 Chain Base（`master` 的 X27 + 既有 LangGraph boundary 與 confirmation interrupt）。X42 尚未合併到 `master`，本 Change 必須建立在 `feat/4.6.5-feat/lane-knowledge-retrieval` 分支之上。**不依賴任何 X28 產物。**
- OpenSpec profile：**lite**（ADR-FL-001，v7 以 ADR-FL-002 延伸至 X45–X48；到期日 2026-11-30 或 X29 開啟時）。

本 Change 完成 v7 業務鏈路「售後客服：找商品 → 問退貨政策（RAG 帶引用，沒證據就拒答）→ 申請退款 → HITL 確認 → 冪等執行 → 狀態回報」中 X42 之後的全部環節，對應 v7 的 D3（Shopping Assistant Graph）與 D4（Refund Under Approval）Gate。v6 X43 的「三個模型 tier 對比與路由表」依 v7 Evidence Split 移至 **X48**，不在本 Change。

## 問題描述

1. **沒有串起業務鏈路的 graph**：`kb_search` 目前只掛在 `mcp_agent` 的通用 tool loop；沒有依意圖分流「商品查詢／政策問答／訂單操作」的 graph，也沒有結構化的「檢索 → 引用驗證 → 合成或拒答」節點。X42 已提供 citation 驗證函式與 `kb_search_result@1` 契約，但拒答的結構化強制明確留給 X43。
2. **沒有任何會改變外部狀態的業務 tool**：runtime 已有 business effect ledger、ToolExecutionRunner、reconciler 與 confirmation interrupt，但沒有任何 `external_mutation` tool 實際走過「durable 審批 → 冪等鍵 → ledger → 未知結果 → reconciliation」全路徑，保證停留在「描述」而非「可展示」。
3. **重複提交無法被觀察為去重**：唯讀核對發現，dispatch pipeline 在映射 runner 結果時捨棄了 `source: "cache"`（已提交結果被重用），而並行重複提交在 claim 未取得時被映射為 `rejected_before_dispatch`。兩者對使用者與事件都不可辨識為「去重」，違反 v7 D4 Gate「第二次提交可觀察為 deduplication，而非 failure」。
4. **審批拒絕、逾期與使用者取消無法區分**：既有 confirmation 節點把 `denied` 映射為 `CONFIRMATION_CANCELLED`；resume 只接受核准或拒絕；等待審批時沒有 active run，既有 `cancel` 輸入在 governance 未啟用時成為 graph 的新輸入、啟用時被視為沒有東西可取消，兩者都不會轉移審批紀錄；逾期只在收到 resume 時才判定。三者因此無法滿足「deny／expire／cancel-before-effect 產生不同 terminal state」。
5. **前端沒有審批與操作狀態介面**：前端只對天氣澄清實作 interrupt resume；`agent.card.emit` 只以通用時間軸列呈現，沒有商品卡片、審批卡片與操作狀態卡片，無法呈現 v6 Invariant 9 與 v7 七種使用者可見狀態。
6. **核准後的副作用無法執行，失敗後也無法重新申請**（apply-change T0 發現）：審批通過後 pipeline 交給 runner 的授權結果沒有決策識別，runner 在占用 ledger claim 後才失敗；而任何未提交即結束的執行都會讓 business effect 永遠停在 `prepared`，之後同一操作的申請一律被當成進行中重複。這是「孤兒鎖」：持有者已結束，claim 卻沒釋放。
7. **客戶端可直接寫入 graph state**（第 9 版，apply-change 期間發現）：BFF 對 LangGraph API 為通用 proxy，客戶端可更新 thread state、建立 thread 時預寫 state、以 `command.update`／`command.goto` 改寫 state 或跳轉節點。審批與待執行的 tool call 都在 state 中，因此可換掉已核准呼叫的輸入，或跳過授權節點直接執行唯讀 tool（既有缺陷，影響所有使用 confirmation 節點的 graph）。
8. **經 Agent Server 的審批 resume 必定無法通過綁定**（第 12 版，apply-change T9 發現）：Agent Server 每次請求都建立新的 run，客戶端無法指定 run 識別；審批消費卻要求承載 resume 的 run 等於觸發審批的原 run，因此經 BFF 與前端的核准一律被拒，效果不會發生。`mcp_agent` 使用同一組授權節點，同樣受影響（既有缺陷）。既有測試讓 interrupt 與 resume 共用同一個 run 識別，因此沒有暴露。
9. **新 graph 的 tool 不一定經 X14 dispatch**：dispatch pipeline 依 graph 來源的 feature flag 啟用，未登錄的來源不會建立 pipeline；所有 local tool 也會載入到每個 graph。若直接沿用，退款 tool 可能繞過 X14 或出現在不該擁有它的 graph（違反 Invariant 1、2、5）。

## 解決方案

1. **`shopping_assistant` graph**：以結構化輸出（Schema 驗證）的意圖路由分流 `product_lookup`、`policy_question`、`order_operation`、`clarify`／`unsupported`。商品結果經既有 `card.emit` 事件族以 `product_result` 卡片呈現；政策問答強制「`kb_search` → citation 驗證 → 合成」或明確拒答；檢索失敗降級為明確「無法回答」。路由錯誤寫入 trace 與評測結果，不以 fallback 吸收。每輪證據只屬於該輪，避免跨輪污染。
2. **三個 tool，全部經 X27 manifest 註冊、經 X14 dispatch 執行**：
   - `order_refund_request`、`order_cancel`：`external_mutation`（模擬）、`trusted_in_process`、無 egress、`business_effect_key` 冪等、`reconcile_only` 補償宣告（不提供補償）、需要 durable 人工審批。
   - `order_operation_status`：唯讀，從 ledger 與審批決策讀取目前狀態，不從助理文字重建歷史。
   - tool 只透過 `shopping_assistant` 的 X27 agent manifest 授予，其他 graph 不得載入訂單 tool。
3. **durable 審批**：沿用 `confirmation-graph` 的 authorization gate → interrupt → resume → physical dispatch，審批紀錄由 X20 durable interrupt manifest 與既有 confirmation store 持久化。模型只能「請求」審批，不能「記錄」審批。拒絕、逾期、生效前取消成為三個不同 terminal state。
4. **邏輯冪等鍵與 ledger**：以「操作種類 + 訂單 + 正規化的退款明細」推導 business effect key（不含 attempt、toolCallId、runId 或理由文字），沿用既有 business effect ledger（每個已提交效果一筆紀錄）與 replay key。補上去重可觀察性：已提交結果被重用、並行重複提交在途中、原操作結果未知，皆回傳可辨識的去重結果並指向原操作。去重以 harness 契約新增的 `deduplicated` 結果類型表達；只有 `shopping_assistant` 選擇接收，其他 graph 的結果與錯誤碼不變（Master 決策，方向 B）。
5. **審批決策傳遞與 claim 釋放**：已消費的審批決策識別一路帶到 dispatch 與 ledger；確定未提交即結束時，在 runner 的集中出口把 business effect 標記為已釋放（以新增的 `released_at` 欄位表達，既有狀態欄位不加新值），之後由使用者重新申請並重新審批時以 compare-and-set 重新占用（Master 決策，做法 A）。結果未知絕不釋放。提交、釋放、重新占用三條路徑以一致順序加鎖。
6. **未知結果與 reconciliation task**：提交後失去回應時，先依 tool 宣告的 reconciler 查詢模擬訂單系統；仍無法判定時進入 `outcome_unknown`，建立 durable reconciliation task（每個 business effect 至多一筆 open task），不盲目重試、不回報成功或失敗。reconciliation worker 屬 X31（Retrofit Debt）。
7. **使用者可見狀態**：前端新增審批卡片、操作狀態卡片與商品卡片；所有生命週期狀態可區分，至少涵蓋 v7 七種（`awaiting_approval`、`executing`、`confirmed`、`deduplicated`、`failed`、`cancelled_before_effect`、`outcome_unknown`），並另以獨立 terminal state 呈現 `approval_denied`、`approval_expired`。**不提供任何 undo affordance**。
8. **客戶端不得直接寫入 graph state**（第 9 版，Master 決策納入 SI-5）：BFF 轉送前拒絕更新 thread state、建立 thread 時預寫 state，以及 `command` 含 `resume` 以外欄位的請求；`shopping_assistant` 宣告只接受訊息與取消欄位的輸入 schema。已消費的決策識別以型別參數傳遞，並在 dispatch 前以 server 端紀錄驗證，客戶端無法偽造。
9. **審批 resume 以伺服器端記錄的等待中 run 綁定**（第 12 版，Master 決策：方向 A）：resume 改以審批紀錄與 interrupt manifest 記錄的等待中 run、同一 thread 綁定；承載 resume 的 run 與客戶端提供的 run 識別都不作為依據，一次性消費、principal／tenant／scope 綁定與逾期判定不變；audit 同時記錄兩個 run。修改位於共用授權節點，`shopping_assistant` 與 `mcp_agent` 同時修正（Master 決策：`mcp_agent` 直接納入）。
10. **評測擴充**：在 X42 dataset 上新增約 15 題商品、政策、訂單與多輪案例（含審批拒絕、生效前取消、重複提交、回應遺失、注入聲稱已預先核准），以 `eval_case` 契約的 additive minor 版本表達；意圖路由準確率與誤分流逐題可追溯。

## 受影響範圍

### 受影響套件

- **backend**：新增 `shopping_assistant` graph 與 `langgraph.json` 註冊；意圖路由結構化輸出與 prompt；三個訂單 tool、SDK manifest adapter、X27 agent manifest；模擬訂單 provider（in-memory、合成 fixture、故障注入）；dispatch pipeline 去重可觀察性（additive）；confirmation 節點以 opt-in 選項區分拒絕／逾期／撤回（`mcp_agent` 不開啟，行為逐位元組不變）；等待審批時的取消由 shopping graph 承接並撤回審批（governance 啟用時以 opt-in 規則轉送取消輸入）與 server 判定逾期（唯讀查詢只計算不寫入）；訂單 tool 輸出只含效果事實，操作狀態由 graph 組成；審批決策傳到 dispatch、未提交即釋放 claim、加鎖順序一致；runtime migration（只新增：審批紀錄新增 `withdrawn_at`／`withdrawn_by_principal_id`、business effect 新增 `released_at`、tool execution 新增 `claim_disposition`、新增 reconciliation task 表；不修改任何既有 CHECK，新舊 instance 可並存）；backend `card.emit` producer（目前不存在）；`card.emit` 的兩種新 card payload；評測擴充。
- **frontend**：新增 `shopping_assistant` agent 選項、商品卡片、審批卡片（approve／deny／生效前取消）、操作狀態卡片；未知 card 安全降級。
- **bff**：第 9 版起有一項程式變更：轉送前拒絕客戶端直接寫入 graph state 的請求（更新 thread state、建立 thread 時預寫 state、`command` 含 `resume` 以外的欄位），唯讀請求、一般輸入與 `command.resume` 不受影響（Master 決策納入 SI-5，design §6.13）。其餘無程式變更：T9 已以整合測試證明 resume、`cancel`、`card.emit`、身分 header 與斷線的傳輸行為不變（2026-10-25）。審批綁定的問題在 backend（第 12 版，解決方案 9），BFF 不需修改；若之後發現需要其他修改，退回本 Proposal 補 delta。
- **deployment**：無新服務。模擬訂單 provider 為 in-memory；reconciliation task 使用既有 runtime Postgres。
- **harness（本 repo 以外）**：`@gun-ai/harness-contracts` 新增 `deduplicated` 結果類型並發布新版；backend 只升級 `@gun-ai/*` 版本。harness 修改在 harness repo 進行（本 repo 的寫入檢查不允許寫入 workspace 以外的路徑）。目前沒有對外服務與其他採用者，Master 決定不要求舊版 runtime 解析新類型。

### 受影響能力域（capability）

- 新增 `commerce-assistant`：意圖路由、商品查詢卡片、政策問答引用與拒答、跨輪隔離、路由可觀測。
- 新增 `approved-order-operations`：訂單 tool 契約、durable 審批、邏輯冪等鍵、ledger、未知結果與 reconciliation task、取消語意、無 undo。
- 新增 `order-operation-status-surface`：使用者可見狀態、審批卡片、狀態單調前進、未知 card 降級。
- 修改 `side-effect-tool-execution-runtime`（ADDED Requirement）：去重結果必須可觀察。
- 修改 `retrieval-evaluation`（ADDED Requirement）：商品、訂單與多輪評測案例。
- 新增 `client-graph-state-boundary`（第 9 版）：客戶端不得經 BFF 直接寫入 graph state；`shopping_assistant` 只接受宣告的輸入欄位。
- 修改 `trusted-tool-authorization`（第 12 版，MODIFIED Requirement「resume MUST 為一次性、scoped，且 Agent MUST NOT 自我批准」）：明確定義「等待中的 Run」以伺服器端 waiting state 為準，承載 resume 的 run 與客戶端 run 識別不作為比對對象。
- 修改 `durable-hitl-conversation-recovery`（第 12 版，MODIFIED Requirement「resume 只回到預期 waiting Task 且最多消費一次」）：runId 驗證對象為伺服器端權威 correlation，承載 resume 的 run 不取代 manifest 的 Run／Task correlation。
- 既有 `governed-knowledge-retrieval`、`agent-tool-manifest`、`unified-tool-dispatch-pipeline`、`runtime-event-contract`、`data-inventory`：**不修改其 Requirement**，本 Change 為 consumer。若 review 認定必須修改，退回本 Proposal 補 MODIFIED delta。

## 目標

- D3 Gate：同一 session 完成「商品查詢 → 政策問答」，政策答案帶可解析引用，且無跨輪污染。
- D4 Gate：**並行**重複提交同一邏輯退款只提交一次，第二次可觀察為去重（Human 確認測試為並行）。
- 審批拒絕、審批逾期、生效前取消產生不同且正確的 terminal state；模型輸出無法記錄審批。
- 模擬「提交後回應遺失」產生 `outcome_unknown` 與 reconciliation task，無盲目重試、無錯誤成功。
- 所有使用者可見狀態可區分；任何介面都沒有 undo affordance。
- 約 15 題商品／訂單／多輪評測案例在鏈路設定上執行並記錄結果，deterministic 與 live 分開回報。

## 非目標

- 三個模型 tier 對比與版本化路由表（**X48**）。
- 任何真實交易、付款或外部訂單 provider 整合（X40）。
- undo、補償 workflow（X31）；reconciliation worker（X31）；操作歷史的使用者可見 projection（X30）。
- 部署、雲端資源、BFF 的限流／成本上限／demo access code（v7 D4 Lane C 與 D5；本 Change 不實作，見 design §13 Q1）。
- 百煉託管版對照（D7）、BM25 混合檢索（D8）、Eval 進 CI（X45）、圖片導購（X47）、前端可觀測與 e2e（X46）、Python 檢索（X44）。
- OS 層級 sandbox（X28c）；本 Change 所有 tool 為 `trusted_in_process`。
- X28-min composition root 遷移。

## 風險

| 風險 | 影響 | 緩解 |
|---|---|---|
| 去重可觀察性修改 harness 的 dispatch 結果型別 | 既有 graph 的 tool 結果映射回歸；窮舉消費者漏處理新類型 | 新類型只對選擇接收的來源發出；legacy 映射對既有 graph 輸出既有值；窮舉消費者未處理時 fail-closed；既有 dispatch、runner、confirmation 測試全數回歸 |
| X43 依賴另一個 repo 的發版 | harness 未發布前，去重相關工作無法完成 | tasks 拆成不依賴 harness 的 T2a 與依賴的 T2b；TH 可與 T2a 並行 |
| confirmation 拒絕語意調整影響 `mcp_agent` | 既有錯誤碼語意改變 | 既有錯誤碼保持不變；新增的區分只透過新欄位或 shopping 專屬映射提供（design §6.4） |
| 意圖路由以關鍵字或 regex 實作 | 違反禁止硬編碼 | 路由必須為 Schema 驗證的結構化輸出；誤分流進評測，不加特殊分支 |
| 審批卡片被誤用為「已確認」 | 不誠實狀態 | `requested`／`approved` 不得顯示為 `confirmed`；狀態 Enum 單一來源，前端只做顯示映射 |
| 模擬 provider 為 in-memory，重啟後狀態遺失 | reconciliation 無法判定 | 判定不了即維持 `outcome_unknown`，不回報成功；記入 Retrofit Debt；demo 為單一 instance |
| scope 粒度與去重涵蓋範圍 | ledger 唯一鍵含 scope；若 scope 比預期細，部分重複無法由 ledger 去重 | 現有證據顯示 scope 為 tenant 層級；T0 確認；模擬 provider 以訂單業務規則回傳 typed「已存在」作為防線（design §13 Q2） |
| 合成資料或 mock tool 被誤解為真實能力 | 對外誤導 | 遵守 v7 External Description Boundary；介面與 README 標註 mock 與 synthetic |
| 審批綁定改為伺服器端等待中 run 後被誤認為放寬授權 | 跨 thread 或重放的 resume 被接受 | thread 綁定、manifest 必須為 waiting、單列 CAS 一次性消費、principal／tenant／scope 綁定不變；interrupt 與 resume 使用不同 run 識別的測試涵蓋拒絕情境，`shopping_assistant` 與 `mcp_agent` 各一組（design §6.14） |
| 檢索內容夾帶「已核准」等指令 | 未經審批的副作用 | 審批只能由 resume 記錄；input schema 拒絕審批欄位；對抗 Scenario 驗證 |

## 回滾策略

- 所有變更為 additive：新 graph、新 tool、新 card payload、新 migration（只建立新表）、新評測案例。
- `shopping_assistant` 由 `langgraph.json` 與前端 agent 清單註冊；移除註冊即停用，不影響既有 graph。
- 訂單 tool 只在 `shopping_assistant` 的 agent manifest 授予；停用 graph 後不會出現在其他 graph。
- 去重可觀察性與 confirmation 區分為 additive；既有 graph 的錯誤碼與結果形狀不變。
- reconciliation task 表為新表；回滾時保留資料、停止寫入即可，不修改既有 ledger 表。
