# client-ip-resolution Specification

## Purpose
定義 BFF 如何依信任代理設定解析 client IP，並讓限流、審計與轉發共用同一個解析結果。來源 Change：demo-cost-and-access-guard。
## Requirements
### Requirement: 只在對端為信任代理時採用轉發的 client IP

BFF MUST 在任何部署模式下以同一規則解析 client IP：只有當 socket 對端位址屬於已設定的信任代理清單時，才從 `x-forwarded-for` 由右往左取出第一個不屬於信任代理的位址；對端不是信任代理時 MUST 使用對端位址並忽略轉發標頭。信任代理清單預設為空。此規則 MUST NOT 受 demo 開關或任何部署 profile 控制。

#### Scenario: 直連訪客偽造轉發標頭

- **GIVEN** 信任代理清單為空（預設）
- **WHEN** 請求帶有任意 `x-forwarded-for` 值
- **THEN** client IP 為 socket 對端位址
- **AND** 偽造的位址不出現在限流鍵、審計或轉發給上游的標頭中

#### Scenario: 經信任代理轉發

- **GIVEN** 對端位址屬於信任代理，`x-forwarded-for` 為「偽造位址, 真實訪客位址」
- **WHEN** BFF 解析 client IP
- **THEN** client IP 為真實訪客位址
- **AND** 偽造位址不影響限流計數

#### Scenario: 多層信任代理

- **GIVEN** 對端位址與 `x-forwarded-for` 最右邊的位址都屬於信任代理
- **WHEN** BFF 由右往左解析
- **THEN** client IP 為第一個不屬於信任代理的位址

#### Scenario: 轉發標頭格式錯誤

- **GIVEN** 對端位址屬於信任代理且轉發標頭含無法解析為位址的片段
- **WHEN** BFF 解析 client IP
- **THEN** client IP 回退為對端位址
- **AND** 審計記錄標示轉發標頭無效

#### Scenario: 轉發標頭全部是信任代理

- **GIVEN** 對端與 `x-forwarded-for` 內每一個位址（含最左邊的位址）都屬於信任代理
- **WHEN** BFF 解析 client IP
- **THEN** client IP 為轉發標頭最左邊的位址，即使該位址本身屬於信任代理
- **AND** 此結果不視為解析失敗，不回退對端位址
- **AND** 審計記錄標示轉發鏈全部為信任代理，供辨識代理自身發出的請求或信任代理清單設定過寬

### Requirement: 限流、審計與轉發共用同一個 client IP 解析結果

同一個請求的限流 IP 維度、審計紀錄與轉發給上游的 `x-forwarded-for` MUST 使用同一次解析的結果；任何元件 MUST NOT 自行重新讀取轉發標頭。

#### Scenario: 三處一致

- **GIVEN** 一個經信任代理轉發的請求
- **WHEN** 請求通過限流、寫入審計並被轉發到上游
- **THEN** 限流鍵、審計 client IP 與上游收到的 `x-forwarded-for` 指向同一個位址

#### Scenario: 非 demo 部署的限流 IP 不變

- **GIVEN** 信任代理清單為空且 demo 開關關閉
- **WHEN** 請求進入限流
- **THEN** IP 維度鍵與本 Change 之前相同（socket 對端位址）

### Requirement: 信任代理設定在啟動時驗證

信任代理清單 MUST 在啟動時驗證：每筆必須是合法的 IP 位址或 CIDR；清單經 trim、去空值與去重。任一筆不合法或涵蓋全部位址（例如 `0.0.0.0/0`、`::/0`）時，程序 MUST 以非零狀態結束並輸出指出設定名稱的穩定錯誤代碼。

#### Scenario: 全開清單

- **GIVEN** 信任代理清單包含 `0.0.0.0/0`
- **WHEN** BFF 啟動
- **THEN** 程序以非零狀態結束並指出信任代理設定不安全
- **AND** 沒有任何埠被監聽

#### Scenario: 格式錯誤的項目

- **GIVEN** 信任代理清單包含無法解析的字串
- **WHEN** BFF 啟動
- **THEN** 程序以非零狀態結束並指出設定名稱，不以忽略該項的方式繼續

