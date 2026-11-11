## Context

本 Change 服務 `second-stage-plan-en-v7-r2.md` Chapter 2 的新加坡部署（D5，Deployment Level 1：Interview demo）。核對基準為 HEAD `a090967`。本版依 Master 2026-11-01 決策改寫為「通用層＋Demo 設定層」兩層架構，取代 2026-10-27 的單層草稿。

現況盤點（設計依據，不是實作指令）：

| 能力 | 現況 | 缺口 |
|---|---|---|
| Client IP（審計／轉發） | 無條件採用 `x-forwarded-for` 第一段 | 可被偽造；與限流用的 IP 不一致 |
| Rate limit | BFF 有記憶體與 Redis 兩種實作；user 與 IP 兩維度；IP 維度只取 socket 對端；Redis 失敗時退回程序內計數 | 無登入時 user 維度全站共用 `anonymous`；代理後 IP 維度退化成一個桶 |
| 用量計量 | 兩個 provider 出口：`platform/llm-gateway.ts`（聊天模型，含模型 fallback 與結構化輸出修復）與 `knowledge/model-gateway.ts`（embedding／rerank，已有 `UsageSink`）；`computeTokenCost`、`recordTokenMetric` 只在測試呼叫；預設費率是佔位值 | 正式路徑沒有累加；結構化輸出修復只保留最後一次回應的 `usage_metadata`；BFF 看不到用量 |
| 准入控制 | 只有限流與認證 | 沒有 run 建立前的預算或配額檢查 |
| 啟動驗證 | `BFF_ALLOWED_ORIGINS` 空值即允許全部 Origin；Redis 未設定即用記憶體；數值不合法回退預設值 | demo 需要 fail-closed |

## Goals / Non-Goals

以 `proposal.md` 為準。本文件補充分層、責任邊界、資料流、替代方案、風險與待決策事項。

## 分層架構

```text
┌──────────────────────── Demo 設定層（demo 開關啟用才掛載）────────────────────────┐
│ DemoProfile：開關與嚴格啟動檢查                                                    │
│ VisitorSessionSubjectResolver：匿名訪客 session cookie → 限流 user 維度鍵           │
│ DemoAdmissionPolicy：全站／分入口每日上限、並行上限、深度研究 IP 配額、           │
│                     graph 允許清單、crons 禁止、resume 放行                         │
└───────────────────────────────┬────────────────────────────────────────────────┘
                                │ 只能單向依賴（import、實作介面、注入設定）
┌───────────────────────────────▼──────── 通用層（永遠生效）────────────────────────┐
│ ClientIpResolver（bff）          RateLimitSubjectResolver 介面（bff，預設：principal）│
│ RunAdmissionPolicy 介面（bff，預設：AllowAll，不讀帳本）＋ 穩定錯誤碼               │
│ UsageLedgerWriter（backend，兩個 provider 出口）  UsageLedgerReader（bff）          │
│ UsageLedgerStore 介面（記憶體預設／Redis）  PriceTable（單價表與金額換算）           │
│ frontend：依錯誤碼渲染降級狀態                                                     │
└────────────────────────────────────────────────────────────────────────────────┘
```

依賴規則：

- Demo 設定層 MAY import 通用層模組、實作通用層介面、在組裝點（composition root）注入通用層。
- 通用層 MUST NOT import 任何 demo 模組、MUST NOT 讀取 demo 開關或任何 `DEMO_*` 設定、MUST NOT 在型別或錯誤碼中出現 demo 專屬語意。
- 組裝點是唯一知道 demo 開關的地方：開關關閉時注入通用層預設實作，開啟時注入 demo 實作。
- 以自動化測試守住邊界（例如掃描通用層模組的 import 圖不得指向 demo 目錄），並以「替換為測試用假政策」的測試證明可替換性。

替換情境（設計驗證用，非本 Change 範圍）：日後改成登入時，以「登入使用者 ID」實作 `RateLimitSubjectResolver`、以「每使用者配額」實作 `RunAdmissionPolicy`，通用層與其測試不需修改。

## Decisions

### D-1：client IP 解析屬於通用層（`client-ip-resolution`）

只有當 socket 對端位址屬於設定的信任代理清單時，才從 `x-forwarded-for` 由右往左取第一個不屬於信任代理的位址；否則一律使用 socket 對端位址。轉發標頭格式錯誤時回退對端位址並在審計標示。轉發鏈每一個位址都屬於信任代理時，取最左邊的位址（它是鏈上最早、已知可信的一跳，比對端更接近來源），不視為解析失敗，並在審計標示「轉發鏈全部為信任代理」，以辨識代理自身發出的請求（例如健康檢查）或信任代理清單設定過寬。限流、審計與轉發給上游的 `x-forwarded-for` 使用同一個解析結果。

- 預設信任代理清單為空。設定值必須是明確的位址或 CIDR；`0.0.0.0/0`、`::/0` 這類全開值在任何模式下都拒絕啟動。
- 替代方案 A：維持現況（信任第一段）。否決：可偽造。
- 替代方案 B：只在 demo 模式啟用新解析。否決：Master 2026-11-01 決定通用層不受 demo 開關控制；可偽造的審計 IP 在任何部署都是缺陷。
- 相容性：代理後的非 demo 部署必須設定信任代理才能取得真實訪客 IP（見 Risks）。

### D-2：用量帳本在 backend 的 provider 出口逐次累加（`model-usage-ledger`）

- 入帳點是「每一次實際送出並得到回應（或錯誤回應但帶 usage）的 provider 呼叫」，不是每次 Graph 呼叫。範圍包含 LLM Gateway（含模型 fallback、重試、結構化輸出修復的每一次嘗試、串流）與 knowledge model gateway（embedding、rerank）。
- 每筆入帳紀錄包含：日期分區、`callKind`（`chat`／`embedding`／`rerank`／`vision`）、`provider`、`model`、`graphId`（取自 execution context；缺失時歸入 `unattributed`，仍計入總額）、input／output token、金額（整數最小單位，見 D-3）與計價狀態（`priced`／`unpriced`／`estimated`）。
- `callKind` 由 provider 出口決定，不由呼叫端自行標示：knowledge model gateway 依呼叫類型記 `embedding` 或 `rerank`；LLM Gateway 依既有的 `ModelPurpose` 推得，`vision` → `vision`，其餘（`chat`、`math`、`research`、`tool`）→ `chat`。對應集中在單一函式並有測試；未知的 purpose 記為 `chat`，並以穩定事件標示。（回應 review-plan-004 Minor 1）
- graph 歸因（回應 review-plan-004 Minor 2；2026-11-02 依 implementation-result-apply-change-001 的 Blocker 修訂）：
  - 事實：共用的 `ExecutionContext`（`@gun-ai/harness-contracts`）是 strict schema，不接受 `graphId`；`agentId` 沒有 Graph ID 語意，GraphEntry 也不填它。先前「從 canonical execution context 讀 graph 識別」的寫法不成立。
  - 唯一可信來源是 graph 註冊點：`backend/langgraph.json` 的 key 就是 graph ID，對應到各模組的 export。本 Change 新增 backend 本地型別 `UsageAttribution`（目前只有 `graphId`），以及一個專用的歸因包裝，由包裝寫入 RunnableConfig 的 configurable，使用專屬的 trusted key；包裝 MUST 先移除用戶端輸入中同名的 key 再寫入，比照 `instrumentGraphWithExecutionContext` 移除 `execution_context` 的做法。graph ID 不得從使用者輸入、assistant 設定或請求內容推得。
  - 既有包裝的現況（2026-11-02 依 review-plan-005 Major 更正，先前寫成「各模組都已用 Opik 包裝傳入自己的 ID」並不正確）：

    | `langgraph.json` key | 既有 export 包裝 | 既有可用的 ID |
    |---|---|---|
    | `chatbot` | 只有 `applyInteractionGovernance`，沒有 Opik 與 execution context 包裝 | 沒有 graph ID 常數 |
    | `deep_researcher` | execution context → governance → Opik | Opik 名稱為 `"weather"`，與 graph ID 不同 |
    | `shopping_assistant` | execution context → governance → Opik | `SHOPPING_ASSISTANT_GRAPH_ID`，與 graph ID 相同 |
    | `math_agent` | 依 `mathDispatchPipelineEnabled` 條件式加 execution context，沒有 Opik | 沒有 graph ID 常數 |
    | `mcp_agent` | execution context → governance → Opik | Opik 名稱為 `"mcp_agent"`，與 graph ID 相同 |

  - 因此歸因包裝不依賴任何既有包裝，也不讀 Opik 名稱：每個 `langgraph.json` 註冊的 graph export 都 MUST 新增一層歸因包裝。graph ID 的單一來源是新增的「已註冊 graph ID」封閉常數集合（值即 `langgraph.json` 的 key），既有的 `SHOPPING_ASSISTANT_GRAPH_ID` 改為引用它。`deep_researcher` 的 Opik 名稱 `"weather"` 不在本 Change 修正，以免改變既有 tracing 資料；列為後續建議。
  - 包裝順序：歸因包裝一律放在 export 的最外層（最後套上），讓它在其他包裝之前完成移除與寫入。`instrumentGraphWithExecutionContext` 只移除 `execution_context`、`taskId`／`task_id` 與 `x-bff-*`，不會移除歸因 key；`applyInteractionGovernance` 與 Opik 包裝原樣傳遞 config。這點以「用戶端偽造歸因被覆蓋」與每個 graph 的歸因測試守住。（回應 review-plan-005 Minor 2）
  - 不修改共用 `ExecutionContext` 契約：它跨套件使用，加欄位需要另一個契約變更，與成本歸因無關的消費者也會受影響。
  - 傳遞：LLM Gateway 的 `ChatModelInvokeOptions` 與 knowledge gateway 的 `KnowledgeCallOptions` 各新增可選欄位 `attribution?: UsageAttribution`，和既有的 `context` 分開。Graph node 呼叫 Gateway 時，以單一 reader 從 node 收到的 config 讀出 `UsageAttribution` 並傳入；Gateway 內部的 fallback、修復與串流 invoker 鏈 MUST 原樣向下傳遞。範圍是每個已註冊 graph 中所有可達的 Gateway 呼叫點，不只 node 本身，也包括被 node 呼叫、目前不接收 config 的 helper function（需要把 config 或 attribution 以參數傳下去）。已知需要補上的例子：`chatbot` 的 `chat_response`，以及 `deep_researcher` 中至少 5 處 `llm.invoke(prompt)`（約在第 1116、1353、1476、2077、3035 行）。完整清單由實作者盤點，並寫入 implementation_result。（回應 review-plan-005 Minor 1）
  - 一致性：以測試確認 `langgraph.json` 中每個 graph 的 export 都有歸因包裝，且包裝的 graph ID 等於 `langgraph.json` 的 key；同時確認「已註冊 graph ID」常數集合與 `langgraph.json` 的 key 完全一致，任一邊多出或缺少都失敗。graph ID 是封閉的 Domain Constant，單一來源是該常數集合。
  - 覆蓋：每個已註冊 graph 都要有一個測試，以 fake provider 跑一次 run，斷言該 run 的全部入帳 graphId 正確、沒有 `unattributed`；這項測試是找出漏傳 attribution 的呼叫點的主要防線。
  - 替代方案 A：擴充共用 `ExecutionContext` 加 `graphId`。否決，理由見上。
  - 替代方案 B：讀 LangGraph server 放進 config metadata 的 `graph_id`／`assistant_id`。否決：這是 LangGraph API 的內部行為、沒有版本承諾，且 `assistant_id` 由用戶端指定。
  - 替代方案 C：以 `AsyncLocalStorage` 做 ambient context。否決：隱式傳遞在並行 fan-out 與 LangGraph 的 async 邊界下難以證明不會串錯 run，且與 knowledge gateway 的顯式契約不一致。
  - `unattributed` 只用於確實沒有 run 的呼叫（例如啟動檢查、評測 CLI）。開放 graph 的 run 產生的入帳不得出現 `unattributed`，以測試守住；否則分入口上限會失去依據。
- 帳本分區以設定的時區計算日期；鍵設 TTL（至少 48 小時）。
- provider 未回報用量時：記錄穩定事件 `usage_missing`，以單價表中該模型的「缺用量估算值」入帳並標記 `estimated`；MUST NOT 以 0 入帳。若該模型沒有估算值，入帳為 `unpriced`。
- 帳本寫入失敗或逾時不得讓已完成的模型回應失敗；記錄 `usage_ledger_write_failed`（不含 prompt 或回應內容）。
- 帳本寫入在模型回應交付的關鍵路徑之外執行（先交付回應，再非同步入帳），並有寫入逾時設定：預設 1000 ms，合法範圍 50–5000 ms；demo 模式必須明確設定。逾時只影響入帳，不影響回應交付。依 Master 決策 6，帳本漏記的成本會讓下一次預算檢查低估，因此 `usage_ledger_write_failed` 必須可觀測（計數指標），並列入最壞超支估算的已知誤差。
- 儲存介面 `UsageLedgerStore` 有兩個實作：程序內記憶體（預設，只供觀測，BFF 讀不到）與 Redis（共用，BFF 可讀）。不設定共用儲存時沿用記憶體，不新增必要設定，既有部署不受影響。
- 修正結構化輸出修復只保留最後一次用量：帳本以每次 delegate 回應各自入帳。回傳給 Graph 的訊息 `usage_metadata` **維持最後一次回應的值**（與現況相同），不改為彙總，因此 Opik tracing、`recordTokenMetric` 與 message normalization 的既有語意不變。帳本與 Graph 可見用量因此可能不同（帳本 ≥ 最後一次），這是刻意的：帳本是成本事實來源，Graph 可見用量只是單次回應的觀測值。
- 替代方案：BFF 從串流事件解析 usage。否決：BFF 不承擔 Agent Workflow 語意，且 `wait`／背景 run 沒有串流可解析。

### D-3：單價表與帳單幣別金額（`model-usage-ledger`）

- 單價表是設定（不是程式常數），每筆含 `provider`、`model`、`callKind`、input／output 單價（每百萬 token 或 provider 計量單位）、`currency`、`source`（官方頁面識別）、`verifiedAt`、可選的缺用量估算值。
- 帳本幣別等於 provider 帳單幣別，由單價表推得：全部項目 MUST 同一幣別，混用即格式錯誤、拒絕啟動。帳本不換匯、不設匯率設定，因此帳本金額與實際帳單一致，也不新增通用層必要設定（Master 決策 M-4）。新加坡區帳單為 USD，所以 demo 的帳本幣別為 USD。
  - 替代方案：保留 CNY 並把匯率做成設定。否決：帳本會隨匯率設定與實際帳單產生落差，且多一項需要核實的設定。
- 金額以帳本幣別的整數最小單位（1e-6 幣別單位）累加，避免浮點誤差；換算規則集中在單一模組並有測試。帳本讀取介面回報帳本幣別，供 BFF 比對上限幣別（D-6）。
- 通用層：缺單價的模型入帳為 `unpriced`，總額另外統計未計價筆數；不會因缺單價而失敗。
- 任何准入政策若啟用金額上限，啟動時 MUST 驗證所有「啟用模型」（含 fallback 鏈與 knowledge 模型）都有單價，否則拒絕啟動。這條規則屬於通用層（啟用上限的必要條件），demo 只是一定會觸發它。
- 目前的佔位費率不得作為任何上限判斷的依據。

### D-4：run 建立前的准入政策介面（`run-admission-guard`）

- 執行順序固定為：既有認證與 CORS → 限流 → 准入政策 → 轉發。被限流拒絕的請求不呼叫准入政策；被准入拒絕的請求已消耗的限流額度不退還（避免以准入拒絕繞過限流探測預算狀態）。
- BFF 在轉發任何會建立 run 的請求（單一 run、stream、wait、batch、crons、審批 resume）前呼叫 `RunAdmissionPolicy.check(request)`。輸入是傳輸層可得的結構化資料：route 種類、`assistant_id`／graphId、`threadId`、限流 subject、client IP、是否為 resume，以及 run 生命週期參數（request body 的 `on_disconnect` 值、是否帶 `after_seconds`、`stream_resumable` 是否為 true；欄位不存在就如實標為不存在，body 無法解析時三者都標為無法判定）；不解析使用者自然語言。
- 結果是 discriminated union：`allow`（可附一個需在 run 結束時釋放的 lease）或 `deny`（穩定錯誤碼、HTTP 狀態、可選 `Retry-After`、可選 `budgetScope`）。
- 通用層提供的預設政策 `AllowAll`：一律 `allow`、不讀帳本、不增加延遲。非 demo 部署的既有行為完全不變。
- 通用層定義的穩定錯誤碼與 HTTP 語意（沿用 BFF 既有錯誤 envelope）：

| 錯誤碼 | HTTP | `Retry-After` | 語意 |
|---|---|---|---|
| `usage_budget_exhausted` | 503 | 距離下次重置的秒數 | 某個預算範圍當日已用完；`budgetScope` 指出範圍 |
| `usage_budget_unavailable` | 503 | 短暫值 | 帳本讀取失敗或逾時，fail-closed |
| `run_quota_exhausted` | 429 | 距離配額重置的秒數 | 某個計數型配額用完 |
| `run_concurrency_limited` | 429 | 短暫值 | 並行 run 已達上限 |
| `feature_disabled` | 403 | 無 | 此部署不提供此功能（route 或 graph） |

- 預算檢查讀帳本逾時或失敗一律 `usage_budget_unavailable`，MUST NOT 以「未知視為未超限」放行；限流的 Redis 失效則沿用既有程序內計數退回（Master 決策 6）。
- 用戶端在檢查期間取消：不轉發；已取得的 lease 立即釋放。
- 持有 lease 的請求的生命週期（通用層，回應 implementation-result-apply-change-002 Blocker；Master 決策 N-4）：
  - **絕對期限**：從准入政策回傳附 lease 的 `allow` 起算，整個請求（所有上游位址嘗試、等待 headers、串流或等待 body）共用一個 `BFF_UPSTREAM_TIMEOUT_MS` 期限，期限到即中止上游。MUST NOT 在取得 headers 後或換上游位址時重新計時。現況（`bff/src/server.ts` 每個上游位址各自計時，取得 headers 後再以完整逾時重新計時）讓 HTTP 存續時間可達逾時的數倍，因此 lease TTL 規則失去依據。
  - **正常完成**：上游串流正常結束或 wait 回應完整送出 → 立即釋放 lease。
  - **上游拒絕建立**：上游在建立 run 前以 4xx 回應（例如 multitask 衝突、驗證錯誤）→ 沒有 run 存在，立即釋放 lease。
  - **異常結束**（用戶端斷線、到達絕對期限、上游 5xx、串流中途錯誤）：BFF 先中止上游連線，再以 run 識別向 backend 發出 run cancel 並等待 terminal 確認；確認後才釋放 lease。取不到 run 識別、cancel 失敗或 lease 到期前沒有取得確認 → 不釋放，由 lease TTL 回收，並記錄穩定的結構化審計事件（含 requestId，不含 body）。
  - cancel 的 action MUST 與上游處理 `on_disconnect: "cancel"` 的語意相同，不得改變既有審批與 side-effect 的 terminal 語意。
  - run 識別的來源（例如回應 header）與 cancel／terminal 確認 API 依本專案使用的 LangGraph server 版本查證，證據寫入 evidence；MUST NOT 以猜測的 URL 或欄位實作。某條路徑無法取得 run 識別時，該路徑的異常結束一律走「由 TTL 回收」。
  - 不持有 lease 的請求（例如預設 `AllowAll` 的所有請求）維持既有逾時與取消行為，非 demo 部署不受影響。
  - 替代方案：(a) 斷線即釋放、只依賴上游的 `on_disconnect: "cancel"`：backend 取消生效前會短暫超過並行上限，不採用；(b) 異常結束一律保留到 TTL：關閉分頁的訪客會佔住名額最多 TTL，並行 3 很容易被鎖住，不採用。
- 不會建立 run 的讀取請求（thread 狀態、歷史、run 查詢）MUST NOT 呼叫准入政策。
- 被拒絕時 BFF 不轉發、不建立 thread 或 run、不合成 assistant 訊息；審計記錄錯誤碼、`budgetScope`、requestId。
- 替代方案：backend Graph 入口自行拒絕。可作為縱深防禦，列入 Open Questions；入口責任仍在 BFF（Master 決策 4）。

### D-5：限流 subject 介面（通用層）

- 通用層定義 `RateLimitSubjectResolver`，預設實作沿用既有 principal（行為不變）。IP 維度改用 D-1 的解析結果（非 demo 模式下對端位址與現況相同，因為現況限流已使用對端位址）。
- Demo 設定層以訪客 session 實作此介面（D-7）。

### D-6：Demo 開關與嚴格啟動檢查（`demo-deployment-profile`）

BFF 與 backend 各自讀取同一語意的 demo 開關（名稱由實作定案，兩端必須相同）。開關啟用時，組裝點在接受任何連線前驗證全部 demo 必要設定；任一缺失、格式錯誤、超出範圍或不安全即以非零狀態結束，輸出指出設定名稱的穩定錯誤代碼，不含 secret；MUST NOT 回退預設值或記憶體實作。

- BFF 必要設定：Origin 白名單（非空、不得含 `*`）、Redis URI、信任代理清單（必須明確設定，可為明確的空清單表示直連）、訪客 session 簽章 secret（長度下限）、session 有效期、全站與各分入口每日上限與上限幣別、並行上限與並行 lease TTL（TTL 減 `BFF_UPSTREAM_TIMEOUT_MS` 的寬限須介於 30–120 秒）、限流數值（session、IP）、深度研究每 IP 每日次數、graph 允許清單、預算檢查逾時、每日重置時區。
- backend 必要設定：Redis URI、帳本鍵前綴、帳本寫入逾時、時區（與 BFF 相同）、涵蓋全部啟用模型的核實單價表、思考模式設定（Gun Shop 所用模型必須關閉；Gun Chat 預設關閉）。
- 「明確設定」的判定（回應 review-plan-004 Minor 4）：以環境變數的 key 是否存在判斷，不以值是否為空判斷。key 不存在 → 缺失，demo 模式拒絕啟動；key 存在且值為空字串（trim 後）→ 明確的空清單，表示直連；有值時依逗號分隔，逐項 trim 後依 D-1 驗證。非 demo 模式 key 不存在時沿用通用層預設的空清單。
- 時區一致性：BFF ready 檢查比對 backend 回報的帳本時區與鍵前綴，不一致即 not ready。
- 幣別一致性（M-4）：BFF 必要設定新增「上限幣別」；ready 檢查比對它與帳本回報的帳本幣別，不一致即 not ready。不一致期間建立 run 的請求依 `usage_budget_unavailable` 拒絕，不以不同幣別的金額比較上限。
- Redis 在啟動時無法連線：ready 回報 not ready；在 Redis 可用前，建立 run 的請求依 `usage_budget_unavailable` 拒絕。

### D-7：訪客 session cookie（`demo-deployment-profile`，B8：完全不設碼）

- 請求沒有有效 session cookie 時，BFF 產生不可猜測的 session ID，簽發 HttpOnly、Secure、`SameSite=Strict` 的 cookie；內容為簽章後的 `{sessionId, issuedAt, expiresAt}`，不含任何身分資料。該請求照常處理，限流以新 session 計數。
- SameSite 固定為 `Strict`，不做成設定（回應 review-plan-004 Minor 3）。SameSite 依「站」（registrable domain）判斷，不依 origin，也不是 CORS 的一部分。cookie 只供 BFF API 的限流使用，不需要在跨站導覽時送出，所以 `Strict` 已足夠，並提供最強的 CSRF 防護。
  - 部署前提：demo 的 frontend 與 BFF MUST 位於同一個站（例如同一個網域下的不同子網域）。注意 `vercel.app`、`onrender.com` 這類平台網域在 Public Suffix List 上，不同子網域彼此是跨站。
  - 跨站部署不在本版範圍：cookie 不會隨請求送出，每個請求都會被視為新訪客並重新簽發，session 維度失效；IP 維度、並行上限與每日上限仍有效，所以不會超支，只是限流退化為只有 IP 維度。Master 決策 N-3 已定案 demo 採同站部署；跨站支援（`SameSite=None` 加 CSRF 防護）留待日後另提 Change。
  - 替代方案 `Lax`：在跨站的 fetch／XHR 請求同樣不會送出，無法解決跨站問題，防護又比 `Strict` 弱，因此不採用。
- 簽章無效或過期的 cookie 視同沒有 cookie，重新簽發；審計記錄 `visitor_session_invalid`／`visitor_session_expired`，不拒絕請求。
- session 只是限流 user 維度鍵，不是身分或權限；principal 仍為 `anonymous`，不改 identity 契約。
- 已知限制：訪客可丟棄 cookie 取得新 session，因此 session 維度只能區分正常訪客，不構成濫用屏障；屏障由 IP 維度、並行上限與每日上限提供。

### D-8：Demo 准入政策（`demo-deployment-profile`）

`DemoAdmissionPolicy` 實作 D-4 介面，依序檢查（任一 deny 即停止）：

1. **功能允許清單**：建立 cron → `feature_disabled`；BFF 不持有連線直到 run 終止的建立路徑（背景單一 run、batch）→ `feature_disabled`（Master 決策 N-1；frontend 的對話與 resume 一律經 `useStream` 走 stream 路徑，不受影響）；graphId 不在允許清單（只開 `chatbot`、`deep_researcher`、`shopping_assistant`）→ `feature_disabled`；run 生命週期參數可能讓 run 活得比 BFF 持有的連線久 → `feature_disabled`，包括 `on_disconnect` 不是 `"cancel"`（含不存在與無法判定）、帶 `after_seconds`、`stream_resumable` 為 true（Master 決策 N-5）。已查證 frontend（`@langchain/langgraph-sdk` 0.0.74 的 `useStream`）一律送出 `on_disconnect: "cancel"`，且不使用 `after_seconds` 與 `stream_resumable`，正常使用不受影響。BFF 不改寫用戶端的 request body。
2. **審批 resume**：放行，不檢查預算與配額（Master 決策 9），但仍計入並行數與最壞超支估算。
3. **全站每日上限**：當日總額 ≥ 全站上限 → `usage_budget_exhausted`（`budgetScope: site`）。
4. **分入口上限**：graphId 對應的預算範圍當日金額 ≥ 該範圍上限 → `usage_budget_exhausted`（`budgetScope` 為該範圍）。對應表為 demo 設定：`shopping_assistant` → `gun_shop`、`chatbot` → `gun_chat`、`deep_researcher` → `deep_research`；`embedding`／`rerank`／`vision` 呼叫一律歸入 `reserve`。`reserve` 只計入全站總額，不單獨擋任何 graph（Master 決策 N-2）。
5. **深度研究每 IP 每日配額**：`deep_researcher` 的 run 以 client IP 計數，達上限 → `run_quota_exhausted`。配額在准入成功時遞增。
6. **並行上限**：取得共用儲存中的並行 lease（帶 TTL），已達上限 → `run_concurrency_limited`；lease 的釋放依 D-4「持有 lease 的請求的生命週期」：正常完成或上游拒絕建立時立即釋放，異常結束時在 run cancel 取得 terminal 確認後釋放，否則由 TTL 回收。

並行 lease 的 TTL 規則（回應 review 2026-11-01 Major 1；依 implementation-result-apply-change-002 Blocker 更正）：

- lease 只發給 BFF 持有連線直到 run 終止的路徑（stream、wait、審批 resume 的串流），且第 1 步已確保這些 run 帶 `on_disconnect: "cancel"`。這些請求的存續時間由 D-4 的絕對期限界定：從取得 lease 起算最多 `BFF_UPSTREAM_TIMEOUT_MS`，期限到 BFF 即中止上游並發出 run cancel。
- 前一版寫「存續時間已由既有 `BFF_UPSTREAM_TIMEOUT_MS` 界定」是錯的：既有逾時在取得 headers 後與換上游位址時都會重新計時，而且用戶端可要求 `on_disconnect: "continue"` 讓 run 在連線關閉後繼續執行。
- lease TTL 減去 `BFF_UPSTREAM_TIMEOUT_MS` 的差稱為寬限，MUST 介於 30 秒與 120 秒之間（含端點）；demo 啟動檢查拒絕超出此範圍的 TTL。寬限不另設設定項，由必要設定 lease TTL 與既有 `BFF_UPSTREAM_TIMEOUT_MS` 推得，避免 demo 嚴格模式出現帶預設值的隱含設定。
  - 下限 30 秒：保留 BFF 在絕對期限中止上游後，發出 run cancel 並取得 terminal 確認的時間。（回應 review 2026-11-01 review-plan-003 Minor 2）
  - 殘餘風險：若 cancel 一直沒有確認，lease 在 TTL 到期時仍會被回收。此時上游連線早已在絕對期限中止，run 依 `on_disconnect: "cancel"` 也應已取消；只有上游的斷線取消與明確 cancel 同時失效時，才會出現「lease 過期但 run 仍在跑」。tasks 6.1 以真實 backend 驗證斷線後 run 在寬限內進入 terminal。
  - 上限 120 秒：限制 BFF 當機後並行容量暫時下降的時間，最多比最長 run 多 2 分鐘。
- BFF 當機時 lease 以 TTL 回收；上游連線隨 BFF 中斷，run 依 `on_disconnect: "cancel"` 取消。回收前並行容量暫時下降（偏保守，不會超支）。
- 不帶串流的背景 run 無法套用此規則，因此 demo 模式在第 1 步以 `feature_disabled` 拒絕（Master 決策 N-1）；lease 一律只會發給 stream、wait 與 resume 的串流路徑。
- 不另外做 lease 續約：續約需要背景計時器與額外失敗模式，而上界已由 D-4 的絕對期限提供。

數值（Master 決策 1，依 M-4 改以帳單幣別 USD 設定）：Master 決策 1 原以 CNY 訂定（全站 1.5、±0.3、最低 1.2；Gun Shop 0.9、Gun Chat 0.2、深度研究 0.3、預留 0.1），依 r2 §4.2 的參考匯率 USD→CNY ≈ 7.2 一次換算為設定值：全站 USD 0.21（可接受調整範圍 ±0.04，最低 0.17），Gun Shop 0.125、Gun Chat 0.028、深度研究 0.042、預留 0.014（合計 0.209）。換算只發生在決定設定值的這一次，執行期不換匯；±範圍是 Master 可接受的全站上限調整範圍，不是執行期容忍度。設定時分入口總和 MUST ≤ 實際設定的全站上限；若全站上限下調，分入口數值必須同步下調，否則啟動檢查拒絕（回應 review Minor 1）；並行 3；session 30／分、IP 60／分；深度研究每 IP 每日 2 次；時區 `Asia/Singapore`。深度研究範圍用完只停用深度研究，其他入口照常。

### D-9：frontend 降級（`run-admission-guard`）

frontend 依 D-4 的錯誤碼（不依顯示文字）渲染降級狀態，有 `Retry-After` 時顯示重置時間；`usage_budget_exhausted` 且 `budgetScope` 為 `deep_research` 時只停用深度研究開關，一般對話照常；降級狀態不渲染為 assistant 訊息；輸入框保留未送出的文字；未知錯誤碼走通用錯誤降級。這是通用層行為：任何部署只要後端回這些錯誤碼就會渲染。

## Package Changes

### frontend

- 依 D-9 渲染五種錯誤碼與未知錯誤碼降級；同源預設帶 cookie，跨源時與 CORS 設定一致。
- 不新增訪問碼畫面（B8）。不持有任何憑證。

### bff

- 通用層：D-1 client IP 解析、D-4 准入介面與 `AllowAll`、D-5 subject 介面、帳本讀取器、新錯誤碼集中定義。
- Demo 設定層：D-6 嚴格啟動檢查、D-7 訪客 session、D-8 准入政策、組裝點的條件注入。
- 審計：記錄准入拒絕、限流拒絕、session 重新簽發，含 requestId，不含 cookie 值。
- 依 `bff/AGENTS.md` 為新行為新增 `node:test` 測試與 `test` script。

### backend

- 通用層：`UsageAttribution` 型別、graph 註冊點的歸因包裝與 reader、兩個 Gateway 呼叫選項的 `attribution` 欄位（不改共用 `ExecutionContext`）、兩個 provider 出口的逐次入帳、單價表、`UsageLedgerStore`（記憶體／Redis）、結構化輸出修復逐次計入、`usage_missing`／`usage_ledger_write_failed` 事件。
- Demo 設定層：D-6 backend 啟動檢查（Redis、單價表完整性、思考模式）。
- 不改 Graph ID、State、Checkpoint、事件契約。

## Security / Permission Analysis

- session 簽章 secret 只來自環境變數或雲端 secret，不進版控、log 或錯誤回應；cookie 為 HttpOnly、Secure。
- 信任代理清單錯誤設定會讓 IP 可偽造；全開值在任何模式下都拒絕啟動。
- 帳本只存計量與金額，不存 prompt、回應內容或使用者資料。
- 本 Change 不新增 Tool 或 MCP；egress 與 MCP typed-denied 屬 D5 Lane A。

## Risks / Trade-offs

- **[非 demo 部署 IP 行為改變]** → 代理後的既有部署需設定信任代理；README 與部署說明標示。
- **[無訪問碼]** → 單一濫用者可在一天內耗盡全站預算；demo 當日停用為可接受結果，寫進 D5 cost acceptance。
- **[只在入口擋 → 超支]** → 最壞超支 = 並行 3 × 單一 run 最大成本 + 預算用完後放行的 resume 成本；單一 run 最大成本以 r2 Chapter 1B 的 E3 實測值界定。
- **[用量低估]** → 帳本覆蓋全部 provider 出口並逐次累加；以測試覆蓋 fallback、修復重試、串流、取消與缺用量。
- **[Redis 單點]** → 預算檢查 fail-closed；限流 fail-open。
- **[共用 `anonymous`]** → 訪客 thread 隔離只靠不可猜測的 thread ID；v2.0.0 接受並記錄於 README（Master 決策 8）。
- **[並行 lease 洩漏]** → lease 帶 TTL；BFF 當機或 cancel 未確認時以 TTL 回收，期間並行容量暫時下降。
- **[run 活得比 lease 久]** → demo 拒絕非 `cancel` 的 `on_disconnect`、`after_seconds` 與可恢復串流；持有 lease 的請求使用絕對期限；異常結束時以 run cancel 的 terminal 確認作為釋放條件（D-4、D-8）。
- **[cancel 呼叫增加 BFF → backend 的耦合]** → 只用於持有 lease 的異常結束；API 依版本查證並記錄證據；取不到確認時保守保留 lease，不會超支，只會暫時降低容量。

## Master 決策紀錄（2026-11-01）

> 依據：Master 於 2026-11-01 對話中的決定。本節與下節共同取代 Open Decisions 的原始建議。

| # | 決定 |
|---|---|
| M-1 兩層架構 | 通用層（信任代理與 client IP、用量與成本帳本、預算檢查介面與錯誤碼）不受 demo 開關控制，預設不啟用上限；Demo 設定層（session cookie、全站每日上限、嚴格啟動檢查）只在 demo 啟用時生效，日後可替換為登入或多租戶配額。 |
| M-2 依賴方向 | 只能是 Demo 設定層 → 通用層。 |
| M-3 B8 訪問碼 | 完全不設碼。移除 access gate 與 `demo-access-gate` capability；session cookie 只作限流鍵。 |

## Master 決策紀錄（2026-10-28）

> 依據：Master 於 2026-10-28 的逐項決定，完整脈絡見根目錄 `second-stage-plan-en-v7-r2.md` 第 3 節（B1–B14）。已全部反映到上方 Decisions 與 specs。

| # | 決定 | 本版落點 |
|---|---|---|
| 1 上限數值 | 每日 CNY 1.5（±0.3）：Gun Shop 0.9、Gun Chat 0.2、深度研究 0.3、預留 0.1；並行 3；session 30／分、IP 60／分；深度研究每 IP 每日 2 次。 | D-8 |
| 2 上限單位 | 帳本記人民幣金額，依官方核實單價換算；任一啟用模型缺核實單價即拒絕啟動。 | D-2、D-3、D-6 |
| 3 超支處理 | 只在 run 開始前擋；最壞超支以並行 3 × 單 run 上限估算。 | D-4、Risks |
| 4 分工 | backend 記錄用量、BFF 擋下建立 run 的請求。 | D-2、D-4 |
| 5 超限回應 | 503 + `Retry-After` + 穩定錯誤碼；降級文案於實作時補。 | D-4、D-9 |
| 6 Redis 失效 | 預算檢查 fail-closed；限流 fail-open。 | D-4、D-6 |
| 7 Access code | 由 M-3 定案為不設碼；時區 `Asia/Singapore`。 | D-7、D-8 |
| 8 共用 `anonymous` | v2.0.0 接受並記錄於 README。 | Risks |
| 9 crons 與 resume | 禁止 crons；預算用完仍放行審批 resume 並計入超支估算。 | D-8 |
| 思考模式 | Gun Shop 一律關閉並於啟動時檢查；Gun Chat 預設關閉（部署設定可開，仍受預算上限；不是 UI 開關，與 `homepage-entry-split` 不衝突）。 | D-6 |
| 開放的 graph | demo 只開 `chatbot`、`deep_researcher`、`shopping_assistant`；`math_agent`、`mcp_agent` 於伺服器端關閉。 | D-8 |
| 深度研究 | 不以訪問碼控制；0.3 元用完只停用深度研究；每 IP 每日 2 次。研究輪數、初始搜尋組數與 egress 管控不在本 Change。 | D-8、Non-Goals |
| 部署與模型 | 新加坡區；部署前全站改用 qwen3.5-flash（r2 Chapter 1B）。 | 單價表設定 |

## Master 決策紀錄（2026-11-02）

> 依據：Master 於 2026-11-02 對話中採用 CCR 對 N-1、N-2、N-3 的建議，並在核准前另就 M-4（帳本幣別）與 M-5（Gate 0.3 位置）採用 CCR 建議。已反映到上方 Decisions 與 specs；本版不再有待 Master 定案的設計決策點。

| # | 決定 | 本版落點 |
|---|---|---|
| N-1 背景 run 的並行計數 | demo 模式以 `feature_disabled` 拒絕 BFF 不持有連線直到 run 終止的建立路徑（背景單一 run、batch）；stream、wait 與審批 resume 的串流照常。已查證 frontend 的對話與 resume 一律經 `useStream` 走 stream 路徑。未採「由 backend 在 run 終止時釋放 lease」，因為需要新的跨層契約。 | D-8 第 1 步、D-8 TTL 規則、demo-deployment-profile spec、tasks 5.4、5.5 |
| N-2 `reserve` 範圍 | embedding、rerank、vision 的費用歸入 `reserve`，只計入全站總額，不單獨擋任何 graph。 | D-8 第 4 步 |
| N-3 demo 部署拓撲 | frontend 與 BFF 部署在同一個站，維持 `SameSite=Strict`；跨站部署不在本版範圍。 | D-7、部署說明（tasks 6.2） |
| M-4 帳本幣別 | 新加坡區官方單價以 USD 計價。帳本幣別等於帳單幣別（由單價表推得，混用即拒絕啟動），不換匯、不設匯率設定。決策 1 的 CNY 數值依 r2 參考匯率 7.2 一次換算為 USD 設定值：全站 0.21（±0.04，最低 0.17），Gun Shop 0.125、Gun Chat 0.028、深度研究 0.042、預留 0.014。BFF 新增上限幣別設定並在 ready 檢查比對。 | D-3、D-6、D-8、model-usage-ledger spec、demo-deployment-profile spec、proposal、tasks 2.1、5.2 |
| M-5 Gate 0.3 位置 | 單價核實與 E3 從實作前 Gate 改為部署前 Gate（tasks 6.4）；本 Change 程式碼不依賴實際單價。切換至 qwen3.5-flash（r2 1B-1）屬模型變更，另開 OpenSpec Change。2026-11-04 起整個部署前 Gate 依 M-6 移到獨立 Change。 | tasks 0.3、6.4 |

## Master 決策紀錄（2026-11-02，第二次）

> 依據：Master 於 2026-11-02 對話中，就 implementation-result-apply-change-002 的 Blocker 採用 CCR 建議。

| # | 決定 | 本版落點 |
|---|---|---|
| N-4 異常結束時的 lease 釋放 | 正常完成立即釋放；異常結束時 BFF 發出 run cancel 並等待 terminal 確認後才釋放；取不到 run 識別、cancel 失敗或未確認就由 TTL 回收。未採「斷線即釋放」（會短暫超過並行上限）與「一律保留到 TTL」（關閉分頁就佔住名額）。 | D-4 生命週期、D-8 第 6 步與 TTL 規則、run-admission-guard spec、tasks 3.5、5.4、6.1 |
| N-5 非 `cancel` 的 `on_disconnect` | demo 以 `feature_disabled` 拒絕 `on_disconnect` 不是 `"cancel"`（含不存在）的建立 run 請求，並一併拒絕 `after_seconds` 與 `stream_resumable: true`；BFF 不改寫 request body。 | D-4 准入輸入、D-8 第 1 步、demo-deployment-profile spec、tasks 5.5 |

## Open Decisions（2026-11-01 提出，已由 2026-11-02 決策紀錄定案；保留作為決策證據）

- **N-1 背景 run 的並行計數**：BFF 只能在 stream／wait 期間知道 run 何時結束；不帶串流的背景 run 建立後 BFF 無法得知終止時間。建議：demo 模式下以 `feature_disabled` 拒絕背景 run（frontend 只用 stream），或改由 backend 在 run 終止時釋放 lease。
- **N-2 `reserve` 範圍**：本版推論 `reserve` 只計入全站總額、不單獨擋 graph；若 Master 希望 embedding／rerank 超過 0.1 元時擋下 Gun Shop，需改為 `shopping_assistant` 同時檢查 `gun_shop` 與 `reserve`。
- **N-3 demo 部署拓撲（同站或跨站）**：D-7 以 `SameSite=Strict` 並假設 frontend 與 BFF 同站。請 Master 確認實際 demo 部署的網域。若同站，維持本版；若必須跨站，需另行決定是否改用 `SameSite=None` 加 CSRF 防護，或接受 session 維度失效、只靠 IP 維度限流。

## Open Decisions（2026-10-27 原始建議，已由上方決策紀錄取代；保留作為決策證據）

1. **上限數值**：每日 token 上限、各維度限流（session／IP／code ID 的視窗與次數、並行 run 上限）、access code 驗證失敗次數上限。建議：先以 D5 預估訪客數與單 run 平均 token 反推，Master 提供數值。
2. **上限單位**：只管 token（**建議**），或另加金額上限。若加金額上限，必須有真實 provider 費率表，缺少費率時 demo 模式拒絕啟動；不得使用目前的佔位費率。
3. **超支處理**：只在 run 開始前擋（**建議**；最壞超支約為並行 run 數 × 單 run 最大 token），或另在 Gateway 中途硬截斷（會讓 run 以錯誤結束，需定義 terminal state 與 UI）。
4. **計量位置與分工**：v7 寫三項都是 BFF 責任，但 BFF 看不到用量。**建議** backend 在 Gateway 記錄用量、BFF 在入口擋下請求；需 Master 確認此分工偏離 v7 文字。
5. **超限回應**：**建議** 503 + `Retry-After` + 穩定錯誤碼，不由 BFF 合成假的 assistant 訊息；降級文案（中／英）待定。
6. **Redis 失效時**：預算檢查**建議**一律拒絕（`demo_budget_unavailable`）；限流是拒絕，還是沿用現有「退回記憶體計數」行為，待決定（多實例下記憶體計數會讓上限乘以實例數）。
7. **Access code 營運**：發放方式（面試前個別發送或單一共用碼）、輪替週期、session 有效期、每日重置的時區。
8. **共用 `anonymous` principal 的風險**：訪客之間的隔離只靠不可猜測的 thread ID。**建議** v2.0.0 接受並記錄，不在本 Change 引入訪客身分。
9. **crons 與審批 resume**：demo 模式是否禁止建立 crons（**建議**禁止）；預算用完時是否也擋等待中的審批 resume（建議放行並計入超支估算）。

## Migration Plan

- 無資料遷移。demo 開關預設關閉。
- 通用層上線後，代理後的部署需新增信任代理設定。
- 回滾：關閉 demo 開關並重啟；通用層 client IP 以信任代理設定調整；Redis 帳本鍵依 TTL 過期。

## Open Questions（交由 review-plan 判斷）

- 是否需要 backend Graph 入口的縱深預算檢查。
- 通用層 client IP 行為改變是否需要對既有 spec 提出 MODIFIED delta（目前未找到規範 `x-forwarded-for` 的既有 Requirement）。
- 未經任何 provider 出口的模型呼叫（例如評測 CLI）是否需要納入帳本或明確排除。
- （已定案）結構化輸出修復後回傳給 Graph 的 `usage_metadata`：維持最後一次，見 D-2。

## Review 處置紀錄（2026-11-01，review-result-review-plan-002）

> 該次審查的 effective verdict 為 INCOMPLETE（`reviewer_provenance_not_observed`：未派出 reviewer subagent），Finding 不構成正式證據。CCR 判斷內容成立，先行修訂，再交新的 review-plan 正式審查。

| Finding | 處置 |
|---|---|
| Major 1 並行 lease TTL 未規範 | 採納：D-8 新增 TTL 規則（TTL ≥ `BFF_UPSTREAM_TIMEOUT_MS` + 寬限，只發給持有連線的路徑），spec 與 tasks 5.4 補 Scenario。 |
| Major 2 Graph 可見 `usage_metadata` 未定義 | 採納 Reviewer 建議：維持最後一次，帳本逐次入帳（D-2）。 |
| Minor 1 ±0.3 可能使分入口總和超過全站 | 採納：明確 ±0.3 是設定調整範圍，分入口總和 ≤ 實際全站上限，啟動檢查已涵蓋（D-8）。 |
| Minor 2 限流與准入順序未指定 | 採納：認證／CORS → 限流 → 准入 → 轉發，准入拒絕不退限流額度（D-4、spec）。 |
| Minor 3 帳本寫入逾時無數值 | 採納：關鍵路徑外非同步入帳，預設 1000 ms、範圍 50–5000 ms（D-2、spec）。 |

## Review 處置紀錄（2026-11-01，review-result-review-plan-003）

> 該次審查已派出 reviewer subagent，但 effective verdict 仍為 INCOMPLETE（`read_scope_violation`：subagent 以 glob 查找 `.agent-runtime/demo-cost-and-access-guard` 下的 `current-state*`，結果為 No files found）。Reviewer 自評 COMMENT_ONLY：0 Blocker、0 Major、2 Minor。Finding 不構成正式證據；Master 決定納入 2 項 Minor 後重審。

| Finding | 處置 |
|---|---|
| Minor 1 轉發鏈全部為信任代理時語意不完整 | 採納：取最左邊位址，不視為解析失敗、不回退對端，審計標示「轉發鏈全部為信任代理」（D-1、client-ip-resolution spec、tasks 1.2）。不採「回退對端」：對端同樣是信任代理，且離來源更遠。 |
| Minor 2 lease 寬限無合法範圍 | 採納：寬限（TTL − `BFF_UPSTREAM_TIMEOUT_MS`）MUST 介於 30–120 秒，由 lease TTL 推得、不另設設定項；啟動檢查拒絕過短與過長（D-6、D-8、demo-deployment-profile spec、tasks 5.2）。 |

## Review 處置紀錄（2026-11-02，review-result-review-plan-004）

> 正式有效的獨立審查：evidenceGate 通過、已派出 reviewer subagent、`readScopeFindings` 為空。Verdict COMMENT_ONLY：0 Blocker、0 Major、4 Minor。依 handoff-review-plan-004 的 onSuccess，由 CCR 仲裁並修進 PLAN_DRAFT，不再重審。adapter 自動推進 PLAN_APPROVED 並建立 apply-change Handoff，與該 Handoff 的 `requiresHumanApproval` 及 `proposalApproved=false` 衝突；Master 指示退回 PLAN_DRAFT，該 Handoff 已標為 REJECTED。

| Finding | 處置 |
|---|---|
| Minor 1 `vision` callKind 沒有入帳路徑 | 採納：`callKind` 由出口決定，LLM Gateway 依既有 `ModelPurpose` 推得（`vision` → `vision`，其餘 → `chat`），對應集中於單一函式；spec 補 vision 與非 vision Scenario（D-2、model-usage-ledger spec、tasks 2.3）。 |
| Minor 2 graphId 傳遞路徑未定義 | 採納 Reviewer 第一個建議：LLM Gateway 呼叫選項比照 `KnowledgeCallOptions.context` 新增可選 execution context，invoker 鏈原樣傳遞；不採 `AsyncLocalStorage`。run 內呼叫不得出現 `unattributed`，spec 補 Scenario（D-2、model-usage-ledger spec、tasks 2.3）。 |
| Minor 3 SameSite 未定值 | 採納但不採 Reviewer 建議的 `Lax`：固定 `SameSite=Strict` 且不可設定，部署前提為 frontend 與 BFF 同站；`Lax` 對跨站 fetch 同樣不送 cookie，無法解決跨站問題。跨站部署會讓 session 維度退化為只靠 IP 維度，列為 N-3 待 Master 定案（D-7、demo-deployment-profile spec、tasks 5.3）。 |
| Minor 4 「明確設定」無判定機制 | 採納：以環境變數 key 是否存在判定；key 存在但值為空字串就是明確的空清單。spec 補「key 存在但為空被接受」Scenario（D-6、demo-deployment-profile spec、tasks 5.2）。 |

## 實作回報處置紀錄（2026-11-02，implementation-result-apply-change-001）

> Codex 依 handoff-apply-change-001 開始實作，完成 client IP 的部分增量後，依 onFailure 停止並回報 Blocker：D-2 要求從 canonical execution context 讀 graph 識別，但共用 `ExecutionContext` 是 strict schema，不接受 `graphId`，`agentId` 也沒有 Graph ID 語意。證據為 `graph-context-contract-probe.json`（加上 `graphId` 即被拒，錯誤為 `unrecognized_keys`）。CCR 已查證屬實：此錯誤來自 CCR 在處理 review-plan-004 Minor 2 時的推論，該推論沒有核對共用契約。

| Finding | 處置 |
|---|---|
| Blocker：graph 歸因缺少可信契約 | 採納：改由 graph 註冊點寫入 backend 本地 `UsageAttribution`（trusted key，先移除用戶端同名 key），兩個 Gateway 呼叫選項各新增可選 `attribution`，不改共用 `ExecutionContext`；新增 knowledge 歸因、偽造歸因、註冊一致性三個 Scenario（D-2、model-usage-ledger spec、tasks 2.3、2.4）。 |

## Review 處置紀錄（2026-11-02，review-result-review-plan-005）

> 正式有效的獨立審查：evidenceGate 通過、已派出 reviewer subagent、`readScopeFindings` 為空。Verdict REQUEST_CHANGES：0 Blocker、1 Major、2 Minor。Reviewer 肯定「註冊點寫入本地 `UsageAttribution`、不改共用契約」的架構方向，也確認 M-4、N-1、N-2、N-3、M-5 的修訂一致且成立。CCR 已逐一查證 Major 引用的程式碼位置，全部屬實。

| Finding | 處置 |
|---|---|
| Major：D-2 對既有包裝的事實陳述有誤 | 採納：D-2 補上 5 個 graph 的既有包裝現況表；歸因包裝改為每個 graph export 都新增、不依賴既有包裝與 Opik 名稱；graph ID 單一來源改為新增的「已註冊 graph ID」常數集合（值即 `langgraph.json` key），並以測試比對；`deep_researcher` 一律記為 `deep_researcher`，不修改其 Opik 名稱 `"weather"`（列為後續建議）。spec 新增「tracing 名稱與 graph ID 不同」Scenario（D-2、model-usage-ledger spec、tasks 2.3）。 |
| Minor 1：只以 chatbot 為例，低估呼叫點範圍 | 採納：範圍明定為所有已註冊 graph 中可達的 Gateway 呼叫點，含 helper function，列出已知的 `chatbot` 與 `deep_researcher` 5 處；完整清單由實作者寫入 implementation_result；每個 graph 各一個 fake provider run 測試。spec 新增「helper function 內的模型呼叫」Scenario（D-2、spec、tasks 2.3）。 |
| Minor 2：包裝順序未規範 | 採納：歸因包裝一律放在 export 最外層，並說明既有包裝不會移除歸因 key（D-2）。不改 backend AGENTS.md，因為這是本 Change 的設計約束，不是全域規則。 |

## 實作回報處置紀錄（2026-11-02，implementation-result-apply-change-002）

> Codex 依 handoff-apply-change-002 完成 tasks 1.1、1.2，並保留帳本、五個 graph 的歸因、Gateway 入帳與准入介面的部分實作，之後依 onFailure 停止並回報 Blocker。證據為 `planning-blocker-002.json`：BFF probe 顯示 `on_disconnect: "continue"` 被原樣轉發，transport 關閉後 lease 已釋放，卻沒有 run cancel。CCR 已查證：`bff/src/server.ts` 原樣轉發 request body；每個上游位址各自建立逾時，取得 headers 後再以完整 `BFF_UPSTREAM_TIMEOUT_MS` 重新計時；frontend 的 SDK（0.0.74）預設送出 `on_disconnect: "cancel"`。Blocker 成立，來源是 CCR 在 D-8 寫下「存續時間已由既有逾時界定」時沒有核對 BFF 的計時方式與 run 的斷線語意。

| Finding | 處置 |
|---|---|
| Blocker：HTTP、run 與 lease 的存續時間前提不成立 | 採納，Master 決策 N-4、N-5：通用層新增持有 lease 請求的絕對期限，以及異常結束時「run cancel 確認後才釋放，否則由 TTL 回收」；demo 拒絕非 `cancel` 的 `on_disconnect`、`after_seconds` 與 `stream_resumable: true`。CCR 另外指出：每個上游位址各自計時也會延長存續時間，一併由絕對期限涵蓋（D-4、D-8、run-admission-guard spec、demo-deployment-profile spec、tasks 3.5、5.4、5.5、6.1、6.2）。 |
| backend 完整測試 3 個失敗（Opik live smoke、PostgreSQL 連線、tool-dispatch 錯誤碼） | 不改規格。下一輪由實作者在不含本 Change 變更的基準上重跑同三個測試，區分既有問題與本次回歸；屬回歸者 MUST 修正，屬環境問題者如實列出。 |

## Review 與 readiness 處置紀錄（2026-11-04，review-result-review-result-003、readiness-result-001）

> review-result-review-result-003 是正式有效的獨立實作審查：evidenceGate 通過、已派出 reviewer subagent、`readScopeFindings` 為空。Verdict APPROVE：0 Blocker、0 Major、1 Minor。前兩次啟動（001、002）因 adapter 誤判與父工作階段改寫結果而 fail-closed，未保存結論。readiness-result-001 判定 NOT_READY：2.5、5.6、6.3 受既有基準失敗阻擋，6.2 待 Master 審閱，6.4 待移出。

| Finding／事項 | 處置 |
|---|---|
| Minor：持有 lease 的串流在 headers 後仍重設 timeout | 不採納（誤判）。CCR 查證：持有 lease 時不建立每個上游位址的 timeout，`activeTimeout` 因此為空，headers 後的重設以「`activeTimeout` 存在」為前提，不會執行；絕對期限只由 lease 生命週期計時器管理，符合 D-4。 |
| 2.5、5.6、6.3 受 3 個既有基準失敗阻擋 | Master 決策 M-7：另開 Change 修正既有失敗（tool-dispatch 錯誤碼），Opik 與 PostgreSQL 於具備環境時重跑；完成後由實作者重跑並勾選。不放寬驗證條件（tasks 7）。 |
| 6.4 部署前 Gate | Master 決策 M-6：移到獨立的部署前 OpenSpec Change；完成前仍不得部署 demo（tasks 0.3、6.4 說明）。 |

## Master 決策紀錄（2026-11-04）

| 決策 | 內容 | 影響 |
|---|---|---|
| M-6 部署前 Gate 位置 | 原 tasks 6.4（正式單價核實、E3 成本量測、qwen3.5-flash 切換）移到獨立的部署前 OpenSpec Change。本 Change 的完成不以部署前 Gate 為條件；demo 部署仍以該 Change 完成為前提。 | tasks 0.3、6.4 說明；M-5 |
| M-7 既有基準失敗 | backend 3 個既有失敗另開 Change 處理，不在本 Change 放寬 2.5、5.6、6.3 的「全數通過」條件。 | tasks 2.5、5.6、6.3、7 |

## Review 處置紀錄（2026-11-06，review-result-review-plan-009）

> 針對 M-6、M-7 修訂的獨立審查。review-result-review-plan-008 因 reviewer subagent 讀取範圍違規（read_scope_violation）作廢，不作為證據。review-result-review-plan-009 是正式有效的獨立審查：evidenceGate 通過、已派出 reviewer subagent、`readScopeFindings` 為空。Verdict APPROVE：0 Blocker、0 Major、0 Minor。Reviewer 確認：移出 6.4 後 proposal、design、specs 與 tasks 一致；「demo 部署以部署前 Change 完成為前提」落在 demo 嚴格啟動檢查拒絕缺核實單價；M-7 未放寬 2.5、5.6、6.3 的驗證條件；實作審查 Minor 的不採納處置成立。殘餘風險為 2.5、5.6、6.3 待基準修正 Change，以及 6.2 待 Master 審閱，皆已記錄於 tasks。
