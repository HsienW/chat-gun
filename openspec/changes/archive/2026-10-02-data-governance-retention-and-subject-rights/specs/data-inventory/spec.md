# data-inventory Specification

## ADDED Requirements

### Requirement: Versioned data inventory 涵蓋每個 data class 的必要屬性

`DataInventoryRegistry` MUST 以 versioned、單一來源方式記錄每個 data class，且每筆 entry MUST 至少含：authoritative store、owner/subject、purpose、sensitivity、retention policy、export behavior、deletion behavior、legal/audit exception、derived copies/caches。inventory schema version MUST 被記錄，未知 schema version MUST fail-closed。

#### Scenario: inventory entry 具備完整屬性

- GIVEN 一個已註冊 data class（例如 conversation／checkpoint／memory／event／audit）
- WHEN 讀取 `DataInventoryRegistry`
- THEN MUST 取得 authoritative store、owner/subject、purpose、sensitivity、retention policy、export behavior、deletion behavior、legal/audit exception、derived copies/caches
- AND 每筆 entry MUST 具 schema version

#### Scenario: 未知 inventory schema version fail-closed

- GIVEN 一份帶未知 schema version 的 inventory entry
- WHEN 載入或驗證 inventory
- THEN MUST fail-closed 並回傳 typed error
- AND MUST NOT 以推導值補齊或靜默放行

#### Scenario: inventory 缺必要屬性被拒

- GIVEN 一份缺少 owner/subject 或 deletion behavior 的 inventory entry
- WHEN 驗證 inventory
- THEN MUST 回傳 typed validation error
- AND MUST NOT 讓該 data class 進入 deletion／export 流程

### Requirement: GovernedDataStore 註冊契約

每個被治理的 store MUST 實作 `GovernedDataStore` 契約：`id`、`exportSubjectData`、`deleteSubjectData`、`verifySubjectDeletion`，並以 registration 讓 deletion coordinator 與 export workflow discover。新增 store MUST 只註冊自身，不修改無關 store 實作。

#### Scenario: store 以 registration 被 discover

- GIVEN 一個新增的 governed store 實作 `GovernedDataStore` 並註冊
- WHEN deletion coordinator 列舉 store
- THEN MUST 無需修改中心 switch 或無關 store 即可被 discover 與呼叫
- AND coordinator MUST NOT 以單一 hard-coded switch statement 列舉所有 store

#### Scenario: 未實作契約的 store 不被誤當 governed

- GIVEN 一個未實作 `GovernedDataStore` 的 store
- WHEN 執行 deletion 或 export
- THEN MUST NOT 被誤納入 governed 處理
- AND inventory completeness 檢查 MUST 標記該 store 為未註冊缺口（而非靜默跳過）

#### Scenario: GovernedDataStore 方法可獨立驗證

- GIVEN 一個 governed store 的三個方法（export／delete／verify）
- WHEN 執行 deletion 或 export workflow
- THEN 每個方法 MUST 可被獨立呼叫與觀察
- AND 失敗的單一 store MUST 不阻斷其他 store 的獨立結果記錄

### Requirement: Data sensitivity 為 typed enum 且未知值 fail-closed

data class 的 sensitivity MUST 為 typed enum（有單一來源、未知值處理與測試）；依 sensitivity 決策 export／deletion／retention／audit 行為時，未知 sensitivity MUST fail-closed，不得以推導值或 default 放行。

#### Scenario: sensitivity 未知值 fail-closed

- GIVEN 一個未知或未來的 sensitivity 值
- WHEN 依 sensitivity 決策 export 或 deletion 行為
- THEN MUST fail-closed 並回傳 typed error
- AND MUST NOT 以預設 sensitivity 補齊

#### Scenario: sensitivity 有單一來源

- GIVEN 多個 store 引用同一 sensitivity enum
- WHEN 解析 sensitivity
- THEN MUST 依單一來源的 enum 解析
- AND 不得在各 store 各自定義散落的 sensitivity 常數

### Requirement: 每個 persistent store 與 derived projection 皆已註冊

所有經 X22 引入的 persistent store 與 derived projection MUST 出現在 inventory；inventory completeness MUST 由測試證明（列舉已註冊 store 對照實際 migration／store 事實）。未註冊的 store MUST 被視為缺口並回報，而非在 deletion／export 時靜默跳過。

#### Scenario: inventory 覆蓋所有 persistent store 與 projection

- GIVEN backend 與 bff 的所有 migration table、memory store、checkpoint、cache 與 derived projection
- WHEN 執行 inventory completeness 測試
- THEN MUST 證明每個持久化事實皆對應一個 inventory entry
- AND 未註冊者 MUST 回報為缺口

#### Scenario: 遺漏 store 不導致靜默跳過

- GIVEN 一個未納入 inventory 的 store
- WHEN 執行 account deletion
- THEN deletion receipt MUST 標記該 store 為「未註冊／待處理」缺口
- AND MUST NOT 宣稱刪除完成

### Requirement: 每個 data class 具可解析的 subject ownership path

每個 governed data class MUST 具可解析的 subject ownership path（direct subject column 或 correlation-key mediated），並於註冊時宣告其 `subjectKey` 與 resolution tier；inventory completeness test MUST 以 subject-reachability 為維度，unreachable store MUST 回報為缺口。

#### Scenario: 每個 data class 可解析至 subject

- GIVEN 一個註冊的 data class
- WHEN 執行 export 或 deletion
- THEN MUST 能依其宣告的 subject ownership path 解析至 subject
- AND MUST NOT 依 metadata JSONB 或 client 欄位反推 subject

#### Scenario: unreachable store 回報為缺口

- GIVEN 一個無 direct column 亦無 correlation key 的 store
- WHEN 執行 inventory completeness 測試
- THEN MUST 回報該 store 為 subject-reachability 缺口
- AND MUST NOT 靜默 skip

### Requirement: Mutable user data 與 immutable minimum audit evidence 分離

mutable user data MUST 與 immutable minimum audit evidence 明確分離；retained audit evidence MUST 被最小化並以 identifier-minimized（opaque／hashed）形式保存，且每個 retained exception MUST 有 documented legal/audit 理由。user export MUST NOT 暴露 raw internal audit log。

#### Scenario: retained audit 具 documented exception 且 identifier-minimized

- GIVEN 需要依 policy 保留的最小 audit evidence
- WHEN 執行 deletion
- THEN retained evidence MUST 記錄 legal/audit exception
- AND 使用的 identifier MUST 為 opaque／hashed，非 raw PII

#### Scenario: export 不含 raw internal audit

- GIVEN 一個 data export request
- WHEN 產生 export
- THEN MUST NOT 包含 raw internal audit log 或未最小化 audit payload
- AND MUST 只含 subject 自身的 non-sensitive、documented 資料

### Requirement: Derived copies 與 cache 納入治理

inventory MUST 記錄每個 data class 的 derived copies 與 caches；cache 與 derived projection MUST 標記為「可重建、可清除、不承載唯一事實」，並在 deletion／verification 中被清除或證明不再暴露 subject data。

#### Scenario: cache 與 derived projection 於 deletion 後不再暴露

- GIVEN 一個含 subject data 的 cache 或 derived projection
- WHEN 執行 deletion 並 verification
- THEN MUST 被清除或經 verify 證明不再暴露 subject data
- AND MUST NOT 以「cache 會自然過期」取代 deletion

#### Scenario: derived copy 不承載唯一事實

- GIVEN 一個 derived projection 已被刪除
- WHEN 由 authoritative fact 重建
- THEN 重建 MUST 不再包含已刪除 subject 的資料
- AND MUST NOT 從 projection 反向重建 authoritative fact
