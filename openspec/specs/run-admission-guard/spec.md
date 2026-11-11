# run-admission-guard Specification

## Purpose
定義 BFF 在建立 run 前呼叫的准入政策介面、通用穩定錯誤碼、預算 fail-closed、持有 lease 的請求生命週期與 frontend 降級呈現。來源 Change：demo-cost-and-access-guard。
## Requirements
### Requirement: BFF 在建立 run 前呼叫准入政策

BFF MUST 依「既有認證與 CORS → 限流 → 准入政策 → 轉發」的固定順序處理請求；被限流拒絕的請求 MUST NOT 呼叫准入政策，被准入拒絕的請求已消耗的限流額度 MUST NOT 退還。BFF MUST 在轉發任何會建立 run 的請求（單一 run、stream、wait、batch、crons 建立、審批 resume）前呼叫已注入的准入政策，輸入只包含傳輸層結構化資料（route 種類、graphId、threadId、限流 subject、client IP、是否為 resume，以及 run 生命週期參數：`on_disconnect` 值、是否帶 `after_seconds`、`stream_resumable` 是否為 true；欄位不存在時 MUST 標為不存在，body 無法解析時 MUST 標為無法判定），MUST NOT 解析使用者自然語言。政策回傳 `allow` 或 `deny`；`deny` 時 BFF MUST NOT 轉發、MUST NOT 建立 thread 或 run、MUST NOT 合成 assistant 訊息，並 MUST 以既有錯誤 envelope 回應政策提供的穩定錯誤碼與 HTTP 狀態。不會建立 run 的讀取請求 MUST NOT 呼叫准入政策。

#### Scenario: 政策放行

- **GIVEN** 准入政策回傳 `allow`
- **WHEN** 訪客送出會建立 run 的請求
- **THEN** BFF 轉發請求並正常串流

#### Scenario: 政策拒絕

- **GIVEN** 准入政策回傳 `deny` 與錯誤碼 `usage_budget_exhausted`
- **WHEN** 訪客送出會建立 run 的請求
- **THEN** BFF 回 503 與 `usage_budget_exhausted`
- **AND** 上游沒有收到請求
- **AND** 審計記錄錯誤碼與 requestId

#### Scenario: 所有建立 run 的路徑都經過政策

- **GIVEN** 准入政策對所有請求回傳 `deny`
- **WHEN** 訪客以單一 run、stream、wait、batch 或 crons 的任一路徑建立 run
- **THEN** 每一條路徑都被拒絕且上游沒有收到請求

#### Scenario: 讀取既有 thread 不經過政策

- **GIVEN** 准入政策對所有請求回傳 `deny`
- **WHEN** 訪客讀取既有 thread 的狀態或歷史
- **THEN** BFF 正常轉發該讀取請求

#### Scenario: 限流先於准入

- **GIVEN** 請求已超過限流上限
- **WHEN** 請求進入 BFF
- **THEN** BFF 回既有限流 429，不呼叫准入政策

#### Scenario: 准入拒絕不退還限流額度

- **GIVEN** 請求通過限流後被准入政策拒絕
- **WHEN** 同一 subject 再送出請求
- **THEN** 被拒絕的那次請求仍計入限流額度

#### Scenario: 用戶端在准入檢查期間取消

- **GIVEN** BFF 正在等待准入政策結果
- **WHEN** 用戶端中斷連線
- **THEN** BFF 不轉發請求
- **AND** 政策已發出的 lease 立即釋放

### Requirement: 持有 lease 的請求以絕對期限與終止確認管理 lease

准入政策回傳附 lease 的 `allow` 時，BFF MUST 從該時點起算一個 `BFF_UPSTREAM_TIMEOUT_MS` 的絕對期限，涵蓋所有上游位址嘗試、等待 headers 與串流或等待 body，期限到即中止上游；MUST NOT 在取得 headers 後或換上游位址時重新計時。上游串流正常結束或 wait 回應完整送出時，BFF MUST 立即釋放 lease；上游在建立 run 前以 4xx 回應時，BFF MUST 立即釋放 lease。用戶端斷線、到達絕對期限、上游 5xx 或串流中途錯誤時，BFF MUST 先中止上游連線，再以 run 識別向 backend 發出 run cancel，取得 terminal 確認後才釋放 lease；cancel 的語意 MUST 與上游處理 `on_disconnect: "cancel"` 相同。取不到 run 識別、cancel 失敗或 lease 到期前沒有取得確認時，BFF MUST NOT 釋放 lease，改由 lease TTL 回收，並 MUST 記錄含 requestId 的結構化審計事件。lease 在任何情況下 MUST 只釋放一次。不持有 lease 的請求 MUST 維持既有逾時與取消行為。

#### Scenario: headers 晚到時仍以准入時點起算期限

- **GIVEN** 一個持有 lease 的 stream 請求，上游在 `BFF_UPSTREAM_TIMEOUT_MS` 到期前 1 秒才回應 headers
- **WHEN** 串流持續送出資料
- **THEN** BFF 在距准入時點 `BFF_UPSTREAM_TIMEOUT_MS` 時中止上游
- **AND** BFF 發出 run cancel

#### Scenario: 多個上游位址共用同一期限

- **GIVEN** 一個持有 lease 的請求，第一個上游位址連線失敗後改用下一個位址
- **WHEN** 計算該請求的期限
- **THEN** 所有位址嘗試共用同一個從准入時點起算的期限

#### Scenario: 正常完成時立即釋放

- **GIVEN** 一個持有 lease 的 stream 請求
- **WHEN** 上游串流正常結束
- **THEN** BFF 立即釋放 lease
- **AND** BFF 沒有發出 run cancel

#### Scenario: 上游拒絕建立 run

- **GIVEN** 一個持有 lease 的請求
- **WHEN** 上游以 4xx 回應且沒有建立 run
- **THEN** BFF 立即釋放 lease

#### Scenario: 用戶端斷線且取消已確認

- **GIVEN** 一個持有 lease 的 stream 請求，上游已回報 run 識別
- **WHEN** 用戶端中途斷線
- **THEN** BFF 中止上游連線並對該 run 發出 run cancel
- **AND** 取得 terminal 確認後才釋放 lease

#### Scenario: 取消未確認時由 TTL 回收

- **GIVEN** 一個持有 lease 的請求異常結束
- **WHEN** 取不到 run 識別、cancel 失敗，或 lease 到期前沒有取得 terminal 確認
- **THEN** BFF 不釋放 lease，lease 由 TTL 回收
- **AND** 審計記錄穩定的事件與 requestId，不含 request body

#### Scenario: 不持有 lease 的請求維持既有行為

- **GIVEN** 准入政策回傳不附 lease 的 `allow`（例如預設政策）
- **WHEN** 上游在取得 headers 後持續串流，或用戶端斷線
- **THEN** BFF 的逾時計算與取消行為與本 Change 之前相同
- **AND** BFF 沒有發出 run cancel

### Requirement: 預設准入政策不設上限且不改變既有行為

未注入其他政策時，BFF MUST 使用預設政策：一律 `allow`、MUST NOT 讀取用量帳本、MUST NOT 需要任何新增設定。預設政策下既有 Route、錯誤碼、延遲特性與回應 MUST 與本 Change 之前相同。

#### Scenario: 非 demo 部署

- **GIVEN** demo 開關關閉且未注入其他政策
- **WHEN** 既有用戶端以既有方式建立 run
- **THEN** 回應與錯誤碼與本 Change 之前相同
- **AND** BFF 沒有讀取帳本或連線帳本儲存

### Requirement: 准入拒絕使用通用穩定錯誤碼

通用層 MUST 集中定義以下錯誤碼與 HTTP 語意，任何政策只能從中選用：`usage_budget_exhausted`（503，`Retry-After` 為距離下次重置的秒數，附 `budgetScope`）、`usage_budget_unavailable`（503）、`run_quota_exhausted`（429，`Retry-After` 為距離配額重置的秒數）、`run_concurrency_limited`（429，附 `Retry-After`）、`feature_disabled`（403）。錯誤碼與欄位 MUST NOT 包含任何部署 profile 專屬名稱。

#### Scenario: 預算耗盡附重置時間

- **GIVEN** 政策判定某預算範圍當日已用完
- **WHEN** BFF 回應
- **THEN** 回應為 503、`usage_budget_exhausted`、`budgetScope` 與 `Retry-After`

#### Scenario: 政策回傳未定義的錯誤碼

- **GIVEN** 政策實作回傳不在集中定義中的錯誤碼
- **WHEN** BFF 處理拒絕結果
- **THEN** BFF 以安全的內部錯誤回應並記錄政策錯誤
- **AND** 不轉發請求

### Requirement: 預算檢查讀取帳本失敗時 fail-closed

政策需要讀取用量帳本時，讀取失敗或超過設定的檢查逾時 MUST 判定為 `usage_budget_unavailable` 並拒絕，MUST NOT 以「未知視為未超限」放行。任何政策啟用金額上限時，啟動時 MUST 驗證帳本為共用儲存且所有啟用模型（含 fallback 與 knowledge 模型）都有單價，否則程序 MUST 以非零狀態結束。

#### Scenario: 帳本不可用

- **GIVEN** 政策啟用金額上限且共用儲存無法連線
- **WHEN** 訪客送出會建立 run 的請求
- **THEN** BFF 回 `usage_budget_unavailable`
- **AND** 上游沒有收到請求

#### Scenario: 帳本讀取逾時

- **GIVEN** 帳本讀取超過檢查逾時
- **WHEN** BFF 等待逾時
- **THEN** BFF 回 `usage_budget_unavailable` 並結束請求

#### Scenario: 啟用上限但缺單價

- **GIVEN** 政策啟用金額上限且某個 fallback 模型沒有單價
- **WHEN** backend 啟動
- **THEN** 程序以非零狀態結束並指出缺少單價的設定

### Requirement: frontend 依錯誤碼呈現准入降級狀態

frontend MUST 依 `usage_budget_exhausted`、`usage_budget_unavailable`、`run_quota_exhausted`、`run_concurrency_limited` 與 `feature_disabled` 呈現對應降級狀態，有 `Retry-After` 時顯示重置時間。frontend MUST NOT 依錯誤訊息文字判斷狀態、MUST NOT 將降級狀態渲染成 assistant 訊息，並 MUST 允許訪客繼續瀏覽既有對話。

#### Scenario: 預算耗盡畫面

- **GIVEN** 訪客送出訊息
- **WHEN** BFF 回 `usage_budget_exhausted` 與 `Retry-After`
- **THEN** frontend 顯示預算耗盡狀態與重置時間
- **AND** 輸入框保留訪客未送出的文字

#### Scenario: 只有深度研究預算耗盡

- **GIVEN** 訪客在 Gun Chat 開啟深度研究並送出訊息
- **WHEN** BFF 回 `usage_budget_exhausted` 且 `budgetScope` 為深度研究範圍
- **THEN** frontend 顯示深度研究暫停的狀態
- **AND** 關閉深度研究後一般對話仍可送出

#### Scenario: 並行受限

- **GIVEN** 訪客送出訊息
- **WHEN** BFF 回 `run_concurrency_limited` 與 `Retry-After`
- **THEN** frontend 顯示可稍後重試的狀態，不自動重送

#### Scenario: 未知錯誤碼

- **GIVEN** BFF 回傳 frontend 不認識的錯誤碼
- **WHEN** frontend 處理該回應
- **THEN** frontend 顯示通用錯誤狀態
- **AND** 不當作成功或預算充足

