## ADDED Requirements

### Requirement: Demo 設定層只能單向依賴通用層

Demo 設定層 MAY 引用通用層模組、實作通用層介面並在組裝點注入；通用層（client IP 解析、用量帳本、准入政策介面與錯誤碼、限流 subject 介面）MUST NOT 引用任何 demo 模組、MUST NOT 讀取 demo 開關或 demo 專屬設定。組裝點 MUST 是唯一依 demo 開關選擇實作的位置。

#### Scenario: 通用層不引用 demo 模組

- **GIVEN** 通用層與 Demo 設定層的原始碼
- **WHEN** 執行層間依賴邊界測試
- **THEN** 通用層模組的 import 圖不包含任何 demo 模組
- **AND** 通用層原始碼不讀取 demo 開關

#### Scenario: Demo 設定層可被替換

- **GIVEN** 以測試用的假政策（例如按登入使用者計數的配額）取代 demo 准入政策與 subject resolver
- **WHEN** 執行通用層與 BFF 准入測試
- **THEN** 測試通過且通用層原始碼沒有修改

### Requirement: demo 模式以單一開關啟用全部 demo 政策

系統 SHALL 提供單一 demo 開關，BFF 與 backend MUST 使用相同語意。開關啟用時，組裝點 MUST 同時注入訪客 session subject resolver、demo 准入政策、共用帳本儲存與 demo 嚴格啟動檢查；任何一項 MUST NOT 能在 demo 模式下被個別關閉。開關未啟用時 MUST 使用通用層預設實作。

#### Scenario: 開啟 demo 模式即啟用全部政策

- **GIVEN** demo 開關啟用且全部必要設定合法
- **WHEN** BFF 與 backend 啟動完成
- **THEN** 限流以訪客 session 與 client IP 計數
- **AND** 會建立 run 的請求經過 demo 准入政策
- **AND** backend 用量寫入共用帳本儲存

#### Scenario: 關閉 demo 模式時使用通用層預設

- **GIVEN** demo 開關未啟用
- **WHEN** 既有用戶端以既有方式呼叫既有 Route
- **THEN** 准入政策為預設的不設上限政策
- **AND** 限流 user 維度沿用既有 principal
- **AND** 不簽發訪客 session cookie

### Requirement: demo 模式缺少必要設定時拒絕啟動

demo 開關啟用時，BFF 與 backend MUST 在接受任何連線前驗證全部 demo 必要設定。任一設定缺失、格式錯誤、超出合法範圍或屬於不安全值時，程序 MUST 以非零狀態結束並輸出指出設定名稱的穩定錯誤代碼，錯誤輸出 MUST NOT 包含 secret。demo 模式下 MUST NOT 以預設值或記憶體實作取代缺失的設定。BFF 必要設定至少包含 Origin 白名單、共用儲存連線、明確設定的信任代理清單、session 簽章 secret 與有效期、全站與各分入口每日上限與上限幣別、並行上限、並行 lease TTL、限流數值、深度研究每 IP 每日次數、graph 允許清單、預算檢查逾時與時區；backend 必要設定至少包含共用儲存連線、帳本鍵前綴、帳本寫入逾時、時區、涵蓋全部啟用模型的核實單價表與思考模式設定。

#### Scenario: 缺少共用儲存設定

- **GIVEN** demo 開關啟用且未提供共用儲存連線設定
- **WHEN** BFF 或 backend 啟動
- **THEN** 程序以非零狀態結束並指出缺少的設定名稱
- **AND** 沒有任何埠被監聽

#### Scenario: Origin 白名單不安全

- **GIVEN** demo 開關啟用且 Origin 白名單為空或包含萬用字元
- **WHEN** BFF 啟動
- **THEN** 程序以非零狀態結束並指出 Origin 設定不合法

#### Scenario: 未明確設定信任代理

- **GIVEN** demo 開關啟用且信任代理的環境變數 key 不存在
- **WHEN** BFF 啟動
- **THEN** 程序以非零狀態結束並指出信任代理設定缺失

#### Scenario: 信任代理明確設為空清單

- **GIVEN** demo 開關啟用且信任代理的環境變數 key 存在，值為空字串或只有空白
- **WHEN** BFF 啟動
- **THEN** 啟動檢查接受該設定，信任代理清單為空（直連）

#### Scenario: 數值設定不合法時不回退預設值

- **GIVEN** demo 開關啟用且全站每日上限為非正數或非數字
- **WHEN** BFF 啟動
- **THEN** 程序以非零狀態結束
- **AND** 不以任何預設上限繼續啟動

#### Scenario: 並行 lease TTL 短於上游逾時

- **GIVEN** demo 開關啟用且並行 lease TTL 小於 `BFF_UPSTREAM_TIMEOUT_MS` 加上 30 秒
- **WHEN** BFF 啟動
- **THEN** 程序以非零狀態結束並指出 lease TTL 設定不合法

#### Scenario: 並行 lease TTL 過長

- **GIVEN** demo 開關啟用且並行 lease TTL 大於 `BFF_UPSTREAM_TIMEOUT_MS` 加上 120 秒
- **WHEN** BFF 啟動
- **THEN** 程序以非零狀態結束並指出 lease TTL 設定不合法

#### Scenario: 並行 lease 寬限位於邊界

- **GIVEN** demo 開關啟用且並行 lease TTL 恰為 `BFF_UPSTREAM_TIMEOUT_MS` 加上 30 秒，或恰為加上 120 秒
- **WHEN** BFF 啟動
- **THEN** 啟動檢查接受該設定

#### Scenario: 分入口上限總和超過全站上限

- **GIVEN** demo 開關啟用且各分入口上限總和大於實際設定的全站上限（例如全站下調為 USD 0.17 而分入口維持 0.125、0.028、0.042、0.014）
- **WHEN** BFF 啟動
- **THEN** 程序以非零狀態結束並指出上限設定不一致

#### Scenario: 啟用模型缺少核實單價

- **GIVEN** demo 開關啟用且某個啟用模型（含 fallback 鏈與 knowledge 模型）沒有單價或缺少核實日期
- **WHEN** backend 啟動
- **THEN** 程序以非零狀態結束並指出缺少單價的模型設定

#### Scenario: Gun Shop 思考模式未關閉

- **GIVEN** demo 開關啟用且 `shopping_assistant` 所用模型設定開啟思考模式
- **WHEN** backend 啟動
- **THEN** 程序以非零狀態結束並指出思考模式設定不合法

#### Scenario: 錯誤輸出不洩漏 secret

- **GIVEN** demo 開關啟用且 session 簽章 secret 長度不足
- **WHEN** BFF 啟動失敗
- **THEN** 錯誤輸出只包含設定名稱與錯誤代碼
- **AND** 不包含 secret 內容或其任何片段

#### Scenario: 共用儲存在啟動時連線逾時

- **GIVEN** demo 開關啟用且共用儲存設定合法但無法在啟動逾時內連線
- **WHEN** BFF 或 backend 啟動
- **THEN** ready 檢查回報 not ready
- **AND** 在共用儲存可用前，會建立 run 的請求以 `usage_budget_unavailable` 被拒絕

#### Scenario: 上限幣別與帳本幣別不一致

- **GIVEN** demo 開關啟用，BFF 的上限幣別為 CNY，而帳本回報的帳本幣別為 USD
- **WHEN** BFF 執行 ready 檢查
- **THEN** ready 回報 not ready 並記錄幣別不一致事件
- **AND** 建立 run 的請求以 `usage_budget_unavailable` 被拒絕，不以不同幣別的金額比較上限

#### Scenario: BFF 與 backend 時區不一致

- **GIVEN** BFF 與 backend 設定不同的帳本時區或鍵前綴
- **WHEN** BFF 執行 ready 檢查
- **THEN** ready 回報 not ready 並記錄設定不一致事件

### Requirement: demo 模式以匿名訪客 session 作為限流 user 維度

demo 模式下，BFF MUST 為沒有有效 session cookie 的請求簽發匿名訪客 session cookie，cookie MUST 為 HttpOnly、Secure 且 `SameSite=Strict`，SameSite 值 MUST NOT 可由設定改變，內容只包含簽章後的 session ID、簽發時間與到期時間。限流 user 維度 MUST 以 session ID 取代共用的匿名 principal；IP 維度 MUST 使用 `client-ip-resolution` 的結果。session MUST NOT 被當作身分或權限，demo 模式 MUST NOT 要求任何訪問碼。

#### Scenario: 首次造訪

- **GIVEN** demo 模式啟用且請求沒有 session cookie
- **WHEN** BFF 處理請求
- **THEN** 回應設定 HttpOnly、Secure、`SameSite=Strict` 的 session cookie
- **AND** 請求照常處理，不要求訪問碼

#### Scenario: 同站的後續請求帶回 cookie

- **GIVEN** frontend 與 BFF 位於同一個站，訪客已取得 session cookie
- **WHEN** frontend 再次呼叫 BFF
- **THEN** 請求帶有該 cookie，BFF 以同一個 session 計數，不重新簽發

#### Scenario: 跨站部署時 session 維度退化

- **GIVEN** frontend 與 BFF 位於不同的站，瀏覽器因 `SameSite=Strict` 不送出 cookie
- **WHEN** 同一位訪客連續呼叫 BFF
- **THEN** 每個請求都被視為新 session 並重新簽發
- **AND** IP 維度限流、並行上限與每日金額上限仍照常生效

#### Scenario: cookie 簽章遭竄改或過期

- **GIVEN** 請求帶有簽章無效或已過期的 session cookie
- **WHEN** BFF 處理請求
- **THEN** BFF 簽發新的 session cookie 並以新 session 計數
- **AND** 審計記錄 session 無效或過期，不記錄 cookie 值

#### Scenario: 不同訪客互不影響

- **GIVEN** 兩位訪客持有不同 session 且來自不同 IP
- **WHEN** 第一位訪客用盡 session 維度額度
- **THEN** 第一位訪客收到 429 與 `retry-after`
- **AND** 第二位訪客的請求不受影響

#### Scenario: 丟棄 cookie 仍受 IP 維度限制

- **GIVEN** 同一 client IP 的請求每次都不帶 cookie
- **WHEN** 請求數超過 IP 維度上限
- **THEN** 該 IP 收到 429 與 `retry-after`

#### Scenario: 限流儲存不可用

- **GIVEN** demo 模式啟用且限流計數儲存暫時不可用
- **WHEN** 請求進入限流檢查
- **THEN** 限流退回程序內計數（fail-open）
- **AND** 記錄穩定的結構化事件，不包含 session secret

### Requirement: demo 准入政策套用全站與分入口每日上限

demo 准入政策 MUST 實作通用層准入介面，並依序檢查：功能允許清單、審批 resume 放行、全站每日金額上限、該 graph 對應預算範圍的每日金額上限、深度研究每 IP 每日次數、並行 run 上限。並行 lease MUST 只發給 BFF 持有連線直到 run 終止、且帶 `on_disconnect: "cancel"` 的路徑，lease 的釋放 MUST 依通用層「持有 lease 的請求以絕對期限與終止確認管理 lease」。TTL 減去 `BFF_UPSTREAM_TIMEOUT_MS` 的寬限 MUST 介於 30 秒與 120 秒之間（含端點），保留絕對期限到期後取得 run cancel 確認的時間，並讓 BFF 當機後的容量下降期間有上界。graph 與預算範圍的對應 MUST 來自 demo 設定；embedding、rerank 與 vision 呼叫歸入預留範圍，預留範圍只計入全站總額。

#### Scenario: 全站上限用完

- **GIVEN** 當日全站金額已達全站上限
- **WHEN** 訪客在任一入口建立 run
- **THEN** BFF 回 `usage_budget_exhausted`，`budgetScope` 為全站
- **AND** `Retry-After` 為距離 `Asia/Singapore` 下一個午夜的秒數

#### Scenario: 只有深度研究範圍用完

- **GIVEN** 深度研究範圍當日金額已達上限，全站與其他範圍未達上限
- **WHEN** 訪客以 `deep_researcher` 建立 run
- **THEN** BFF 回 `usage_budget_exhausted`，`budgetScope` 為深度研究
- **AND** 以 `chatbot` 或 `shopping_assistant` 建立 run 仍被放行

#### Scenario: 深度研究每 IP 每日次數用完

- **GIVEN** 同一 client IP 當日已成功建立 2 次 `deep_researcher` run
- **WHEN** 該 IP 第 3 次建立 `deep_researcher` run
- **THEN** BFF 回 `run_quota_exhausted` 與 `Retry-After`
- **AND** 其他 IP 不受影響

#### Scenario: 並行 run 達上限

- **GIVEN** 已有 3 個進行中的 run 持有並行 lease
- **WHEN** 第 4 個建立 run 的請求進入
- **THEN** BFF 回 `run_concurrency_limited`
- **AND** 任一進行中的 run 終止後，新請求可取得 lease

#### Scenario: run 結束時釋放並行 lease

- **GIVEN** 一個 run 持有並行 lease
- **WHEN** 該 run 正常完成，或用戶端斷線、BFF 到達絕對期限後 run cancel 取得 terminal 確認
- **THEN** lease 被釋放且只釋放一次

#### Scenario: 斷線後 run 不會在釋放 lease 後繼續執行

- **GIVEN** 3 個 run 持有並行 lease，其中一個的用戶端中途斷線
- **WHEN** 第 4 個建立 run 的請求進入
- **THEN** 只有在斷線的 run 取得 terminal 確認後，第 4 個請求才能取得 lease
- **AND** 任何時點進行中的 run 都不超過 3 個

#### Scenario: 長時間 run 不會讓並行數超過上限

- **GIVEN** 3 個 `deep_researcher` run 持有並行 lease 且持續執行到接近絕對期限，其中一個的 headers 晚到
- **WHEN** 第 4 個建立 run 的請求在此期間進入
- **THEN** BFF 回 `run_concurrency_limited`
- **AND** 3 個 lease 在對應 run 被 BFF 終止並確認前都沒有過期

#### Scenario: BFF 當機後 lease 由 TTL 回收

- **GIVEN** BFF 在持有 lease 時異常終止，沒有執行釋放
- **WHEN** lease TTL 到期
- **THEN** 該 lease 被回收，新請求可再取得 lease
- **AND** 上游已因連線中斷依 `on_disconnect: "cancel"` 取消該 run

#### Scenario: 預算檢查期間帳本不可用

- **GIVEN** demo 模式啟用且帳本讀取失敗
- **WHEN** 訪客建立 run
- **THEN** BFF 回 `usage_budget_unavailable`，不以未知視為未超限

#### Scenario: 預留範圍超過其額度不擋任何 graph

- **GIVEN** 當日 embedding、rerank 與 vision 的累計金額已超過預留範圍額度，全站與各 graph 範圍未達上限
- **WHEN** 訪客以 `shopping_assistant`、`chatbot` 或 `deep_researcher` 建立 run
- **THEN** BFF 放行
- **AND** 預留範圍的金額仍計入全站總額

### Requirement: demo 模式關閉非開放功能並放行審批 resume

demo 模式下，建立 cron、以不在允許清單中的 graph（`math_agent`、`mcp_agent` 等）建立 run，以及以 BFF 不持有連線直到 run 終止的路徑（背景單一 run、batch）建立 run，MUST 回 `feature_disabled` 且不轉發。審批 resume 同樣 MUST 經 stream 或 wait 路徑提交，以背景路徑提交時 MUST 回 `feature_disabled`。建立 run 的請求（含 resume）若 `on_disconnect` 不是 `"cancel"`（含不存在與無法判定）、帶 `after_seconds`，或 `stream_resumable` 為 true，MUST 回 `feature_disabled`、不轉發、不取得並行 lease；BFF MUST NOT 改寫 request body。預算用完時，等待中審批的 resume MUST 被放行，且 MUST NOT 改變既有審批與 side-effect 語意；放行的 resume 仍 MUST 計入並行數與帳本。

#### Scenario: 建立 cron

- **GIVEN** demo 模式啟用
- **WHEN** 訪客嘗試建立 cron
- **THEN** BFF 回 `feature_disabled`
- **AND** 上游沒有收到請求

#### Scenario: 呼叫未開放的 graph

- **GIVEN** demo 模式啟用
- **WHEN** 訪客以 `math_agent` 或 `mcp_agent` 建立 run
- **THEN** BFF 回 `feature_disabled`
- **AND** 上游沒有收到請求

#### Scenario: 建立背景 run 或 batch

- **GIVEN** demo 模式啟用
- **WHEN** 訪客以背景單一 run 或 batch 路徑建立 run，graph 屬於允許清單
- **THEN** BFF 回 `feature_disabled`
- **AND** 上游沒有收到請求
- **AND** 不取得並行 lease

#### Scenario: stream 與 wait 路徑照常

- **GIVEN** demo 模式啟用且預算、配額與並行數都未達上限
- **WHEN** 訪客以 stream 或 wait 路徑對允許清單中的 graph 建立 run，且帶 `on_disconnect: "cancel"`
- **THEN** BFF 放行並取得並行 lease

#### Scenario: 要求斷線後繼續執行

- **GIVEN** demo 模式啟用
- **WHEN** 訪客以 stream、wait 或 resume 路徑建立 run，`on_disconnect` 為 `"continue"` 或不存在
- **THEN** BFF 回 `feature_disabled`
- **AND** 上游沒有收到請求
- **AND** 不取得並行 lease

#### Scenario: 要求延後執行或可恢復串流

- **GIVEN** demo 模式啟用
- **WHEN** 訪客建立 run 的請求帶 `after_seconds`，或 `stream_resumable` 為 true
- **THEN** BFF 回 `feature_disabled`
- **AND** 上游沒有收到請求

#### Scenario: 無法解析的 request body

- **GIVEN** demo 模式啟用
- **WHEN** 建立 run 的 request body 無法解析，無法判定 `on_disconnect`
- **THEN** BFF 回 `feature_disabled`；若既有流程在呼叫准入政策前已以請求格式錯誤拒絕，維持既有回應
- **AND** 上游沒有收到請求，也不取得並行 lease

#### Scenario: 預算耗盡時 resume 等待中的審批

- **GIVEN** 當日全站預算已耗盡且有一個等待審批的 `shopping_assistant` run
- **WHEN** 訪客提交審批 resume
- **THEN** BFF 放行 resume
- **AND** 審批與 side-effect 的 terminal state 與非 demo 模式一致
- **AND** resume 產生的模型用量照常入帳
