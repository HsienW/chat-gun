## ADDED Requirements

### Requirement: 每一次 provider 呼叫都在 provider 出口入帳

backend MUST 在全部 provider 出口（聊天模型的 LLM Gateway 與 knowledge 的 embedding／rerank model gateway），於每一次 provider 回應後將該次實際用量寫入用量帳本。模型 fallback、重試、結構化輸出修復與串流中的每一次 provider 回應 MUST 各自入帳，MUST NOT 只計入最後一次。入帳 MUST NOT 受 demo 開關或任何部署 profile 控制。每筆入帳 MUST 包含日期分區、`callKind`、provider、model、graphId（缺失時為 `unattributed`）、input／output 用量、金額與計價狀態，MUST NOT 包含 prompt、回應內容或使用者資料。`callKind` MUST 由 provider 出口依呼叫類型決定：knowledge gateway 記 `embedding` 或 `rerank`，LLM Gateway 依模型用途記 `vision` 或 `chat`。graphId MUST 取自呼叫時顯式傳入的用量歸因（`UsageAttribution`），用量歸因 MUST 只由每個已註冊 graph 的 export 最外層的歸因包裝，依該 graph 已註冊的 graph ID 寫入；歸因包裝 MUST NOT 依賴其他既有包裝或 tracing 名稱。已註冊 graph 中所有可達的 Gateway 呼叫點（含 helper function）MUST 傳遞用量歸因，MUST NOT 取自使用者輸入、assistant 設定或請求內容；用戶端輸入中同名的歸因欄位 MUST 被移除。兩個 Gateway 內部的 fallback、修復與串流路徑 MUST 原樣傳遞用量歸因。本 Requirement MUST NOT 修改共用的 execution context 契約。屬於某個 run 的呼叫 MUST NOT 記為 `unattributed`。

#### Scenario: 一般模型呼叫

- **GIVEN** 帳本當日金額為 N
- **WHEN** 一次聊天模型呼叫回報 input 與 output token，依單價換算金額為 C
- **THEN** 帳本當日金額變為 N + C
- **AND** 該筆紀錄的計價狀態為 `priced`

#### Scenario: 結構化輸出修復重試

- **GIVEN** 一次結構化輸出請求經過兩次 provider 呼叫才成功，金額分別為 C1 與 C2
- **WHEN** 呼叫完成
- **THEN** 帳本增加 C1 + C2，且有兩筆入帳紀錄

#### Scenario: Graph 可見的用量維持最後一次回應

- **GIVEN** 一次結構化輸出請求經過兩次 provider 呼叫才成功
- **WHEN** Gateway 把結果回傳給 Graph
- **THEN** 回傳訊息的 `usage_metadata` 等於第二次回應的用量（與本 Change 之前相同）
- **AND** 帳本仍分別記入兩次用量
- **AND** Opik tracing 與既有 token 指標讀到的值與本 Change 之前相同

#### Scenario: 結構化輸出修復最終失敗

- **GIVEN** 結構化輸出修復用盡嘗試次數仍失敗，期間有三次 provider 回應
- **WHEN** Gateway 拋出修復耗盡錯誤
- **THEN** 三次回應的用量全部入帳

#### Scenario: 模型 fallback

- **GIVEN** 主要模型回應錯誤但帶有用量，fallback 模型隨後成功
- **WHEN** 呼叫完成
- **THEN** 兩個模型的用量各自以其單價入帳

#### Scenario: embedding 與 rerank 呼叫

- **GIVEN** knowledge 檢索呼叫 embedding 與 rerank provider
- **WHEN** provider 回報用量
- **THEN** 兩次呼叫分別以 `callKind` `embedding` 與 `rerank` 入帳

#### Scenario: vision 模型呼叫

- **GIVEN** 一次以 vision 用途透過 LLM Gateway 送出的模型呼叫
- **WHEN** provider 回報用量
- **THEN** 該筆以 `callKind` `vision` 入帳，並使用單價表中 `vision` 的單價

#### Scenario: 非 vision 用途的聊天模型呼叫

- **GIVEN** 一次以 chat、math、research 或 tool 用途透過 LLM Gateway 送出的模型呼叫
- **WHEN** provider 回報用量
- **THEN** 該筆以 `callKind` `chat` 入帳

#### Scenario: run 內的呼叫可歸因到 graph

- **GIVEN** 某個 graph 的 run 透過 LLM Gateway 呼叫模型，期間發生 fallback 與結構化輸出修復
- **WHEN** 各次 provider 回應入帳
- **THEN** 每一筆紀錄的 graphId 都是該 run 的 graph
- **AND** 沒有任何一筆記為 `unattributed`

#### Scenario: knowledge 呼叫可歸因到 graph

- **GIVEN** 某個 graph 的 run 在檢索中呼叫 embedding 與 rerank
- **WHEN** 兩次呼叫入帳
- **THEN** 兩筆紀錄的 graphId 都是該 run 的 graph

#### Scenario: 用戶端偽造歸因

- **GIVEN** 用戶端在 run 的 config 或輸入中放入指向其他 graph 的歸因欄位
- **WHEN** 該 run 呼叫模型並入帳
- **THEN** 入帳的 graphId 是實際執行的 graph，不是用戶端提供的值

#### Scenario: 每個已註冊 graph 都有歸因包裝

- **GIVEN** 部署設定中註冊的全部 graph
- **WHEN** 執行歸因一致性測試
- **THEN** 每個 graph 的 export 都經過歸因包裝，且包裝使用的 graph ID 等於註冊的 graph ID
- **AND** 已註冊 graph ID 常數集合與部署設定的 graph 完全一致

#### Scenario: tracing 名稱與 graph ID 不同

- **GIVEN** 某個 graph 的 tracing 名稱與其註冊的 graph ID 不同（例如 `deep_researcher` 的 tracing 名稱為 `weather`）
- **WHEN** 該 graph 的 run 呼叫模型並入帳
- **THEN** 入帳的 graphId 是註冊的 graph ID，不是 tracing 名稱

#### Scenario: helper function 內的模型呼叫

- **GIVEN** 某個 graph 的 node 透過 helper function 呼叫 Gateway
- **WHEN** 該呼叫入帳
- **THEN** graphId 是該 run 的 graph，沒有因為 helper 未接收 config 而記為 `unattributed`

#### Scenario: provider 回應後 run 被取消

- **GIVEN** provider 已回傳含用量的回應
- **WHEN** run 在後續處理前被取消
- **THEN** 已回報的用量仍入帳

#### Scenario: 串流回應

- **GIVEN** 一次串流模型呼叫在最後的 chunk 回報用量
- **WHEN** 串流完成
- **THEN** 該次用量入帳一次，不因 chunk 數量重複入帳

#### Scenario: 缺少 execution context

- **GIVEN** 模型呼叫不屬於任何 run，沒有可用的 graphId（例如啟動檢查或評測 CLI）
- **WHEN** 用量入帳
- **THEN** graphId 記為 `unattributed`
- **AND** 該筆金額仍計入當日總額

### Requirement: provider 未回報用量時不得以 0 入帳

provider 回應沒有用量欄位時，backend MUST 記錄穩定事件 `usage_missing`。若單價表為該模型提供缺用量估算值，MUST 以估算值入帳並標記 `estimated`；否則 MUST 標記 `unpriced`。任何情況 MUST NOT 以 0 金額標記為 `priced`。

#### Scenario: 有估算值

- **GIVEN** provider 回應沒有用量欄位，且單價表為該模型設定了估算值 E
- **WHEN** Gateway 處理回應
- **THEN** backend 記錄 `usage_missing` 事件
- **AND** 帳本增加 E，計價狀態為 `estimated`

#### Scenario: 沒有估算值

- **GIVEN** provider 回應沒有用量欄位，且該模型沒有估算值
- **WHEN** Gateway 處理回應
- **THEN** 該筆計價狀態為 `unpriced`，當日未計價筆數加一

### Requirement: 以設定的單價表換算帳單幣別金額

金額 MUST 依設定的單價表換算，單價表每筆 MUST 包含 provider、model、`callKind`、單價、幣別、來源與核實日期。單價表內全部項目 MUST 使用同一幣別，該幣別即為帳本幣別（即 provider 帳單幣別）；帳本 MUST NOT 進行任何換匯，也 MUST NOT 新增匯率設定。單價表混用幣別時 MUST 視為格式錯誤。帳本讀取介面 MUST 回報帳本幣別。金額 MUST 以帳本幣別的整數最小單位累加。缺少單價的模型 MUST 入帳為 `unpriced` 並計入未計價筆數，MUST NOT 使用佔位費率或推測值。單價表格式錯誤 MUST 讓程序以非零狀態結束。

#### Scenario: 缺少單價

- **GIVEN** 單價表沒有某個啟用模型的項目，且沒有任何准入政策啟用金額上限
- **WHEN** 該模型被呼叫
- **THEN** 用量入帳為 `unpriced`
- **AND** 模型回應照常交付

#### Scenario: 金額累加不產生浮點誤差

- **GIVEN** 大量小額呼叫
- **WHEN** 帳本累加
- **THEN** 總額等於各筆整數金額的精確和

#### Scenario: 單價表格式錯誤

- **GIVEN** 單價表某筆缺少幣別或單價為負數
- **WHEN** backend 啟動
- **THEN** 程序以非零狀態結束並指出設定名稱

#### Scenario: 單價表混用幣別

- **GIVEN** 單價表中一筆為 USD、另一筆為 CNY
- **WHEN** backend 啟動
- **THEN** 程序以非零狀態結束並指出單價表幣別不一致
- **AND** 不以任何匯率換算後繼續啟動

#### Scenario: 帳本幣別取自單價表

- **GIVEN** 單價表全部項目為 USD
- **WHEN** BFF 透過讀取介面查詢當日總額
- **THEN** 回應的金額以 USD 最小單位表示，並回報帳本幣別為 USD

### Requirement: 帳本儲存介面與日期分區

帳本 MUST 透過儲存介面寫入，至少提供程序內記憶體（預設）與共用儲存兩種實作；未設定共用儲存時 MUST 使用記憶體實作且 MUST NOT 新增必要設定。日期分區 MUST 以設定的時區計算，共用儲存的鍵 MUST 設定到期時間（至少 48 小時）。BFF MUST 能透過唯讀介面讀取共用儲存中的當日總額與各 graphId、`callKind` 的分項。

#### Scenario: 未設定共用儲存

- **GIVEN** 沒有設定帳本共用儲存
- **WHEN** backend 啟動並處理模型呼叫
- **THEN** 啟動成功且用量寫入程序內記憶體帳本
- **AND** 不嘗試連線任何外部儲存

#### Scenario: 跨日重置

- **GIVEN** 帳本以設定時區計算日期
- **WHEN** 設定時區跨過午夜
- **THEN** 新的用量計入新日期分區
- **AND** 前一日分區不再被讀取作為當日金額

#### Scenario: 共用儲存可被 BFF 讀取

- **GIVEN** backend 與 BFF 設定同一個共用儲存、鍵前綴與時區
- **WHEN** backend 入帳後 BFF 讀取當日總額
- **THEN** BFF 讀到包含該筆入帳的金額

### Requirement: 帳本寫入失敗不影響模型回應

帳本寫入 MUST 在模型回應交付的關鍵路徑之外執行，並 MUST 有可設定的寫入逾時（預設 1000 ms，合法範圍 50–5000 ms，超出範圍拒絕啟動）。帳本寫入失敗或超過寫入逾時時，backend MUST 照常把模型回應交付給呼叫端，並記錄穩定事件 `usage_ledger_write_failed`（不含 prompt 或回應內容）與對應的失敗計數指標。

#### Scenario: 共用儲存寫入失敗

- **GIVEN** 共用儲存在寫入時回傳錯誤
- **WHEN** 模型呼叫已成功完成
- **THEN** 模型回應照常交付給 Graph
- **AND** backend 記錄 `usage_ledger_write_failed`

#### Scenario: 共用儲存寫入逾時

- **GIVEN** 共用儲存在寫入逾時內沒有回應
- **WHEN** 逾時發生
- **THEN** 模型回應的交付時間不受帳本寫入影響
- **AND** backend 記錄 `usage_ledger_write_failed` 並遞增失敗計數

#### Scenario: 寫入逾時設定超出範圍

- **GIVEN** 帳本寫入逾時設定為 0 或大於 5000 ms
- **WHEN** backend 啟動
- **THEN** 程序以非零狀態結束並指出設定名稱
