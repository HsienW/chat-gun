# synthetic-order-owner-binding Specification

## Purpose

定義 synthetic 模擬訂單擁有者綁定的設定、trusted 身分比對、epoch 重置、審計與評估隔離行為，支援 demo 訪客完成經人工審批的訂單操作。

## Requirements

### Requirement: 模擬訂單擁有者綁定 MUST 只來自明確設定且只在 synthetic 模擬訂單系統生效

系統 MUST 能以設定指定一個 trusted 來源身分（tenant 與 principal）在模擬訂單系統中對應到 synthetic fixture 的一個擁有者（tenant 與擁有者 principal）。綁定 MUST 預設不啟用，MUST NOT 以程式常數提供任何預設來源或目標。綁定 MUST 只能附加在 synthetic provenance 的模擬訂單系統上；非 synthetic 的訂單系統 MUST NOT 接受綁定。綁定 MUST NOT 修改 trusted identity、tenant、scope、角色或任何身分解析結果。

#### Scenario: 綁定啟用時 demo 訪客可核准自己的 fixture 訂單退款

- **GIVEN** 綁定已啟用，來源為 trusted `public`／`anonymous`，目標為 fixture 擁有者 `synthetic-tenant`／`synthetic-shopper-a`
- **AND** demo 訪客以 trusted `public`／`anonymous` 申請 ORD-1001 退款
- **WHEN** 訪客經介面核准
- **THEN** 退款 MUST 實際提交一次並以確認結束
- **AND** ledger MUST 有一筆已提交的 business effect，其 tenant 與 scope MUST 為 trusted 身分的 tenant 與 scope
- **AND** 審批、操作請求與狀態查詢 MUST 以 trusted 身分記錄與讀取

#### Scenario: 未設定綁定時維持查無訂單

- **GIVEN** 沒有任何綁定設定，或綁定設定為不啟用
- **WHEN** demo 訪客核准 ORD-1001 退款
- **THEN** 結果 MUST 為查無訂單
- **AND** MUST NOT 退回任何預設擁有者

#### Scenario: 身分層不受綁定影響

- **GIVEN** 綁定已啟用
- **WHEN** 檢查 BFF 解析出的 trusted identity 與 backend 收到的 canonical execution context
- **THEN** 兩者 MUST 仍為 `public`／`anonymous`
- **AND** 其他 graph 的 audit 與 scope MUST NOT 出現綁定目標的身分

#### Scenario: 非 synthetic 訂單系統不接受綁定

- **GIVEN** 訂單系統不是 synthetic provenance 的模擬訂單系統
- **WHEN** 嘗試以綁定組裝訂單系統
- **THEN** 組裝 MUST 失敗或在型別上不可表達
- **AND** MUST NOT 以任何形式套用綁定

---

### Requirement: 綁定設定 MUST 在啟動時驗證並 fail-closed

綁定啟用時，所有欄位（來源 tenant、來源 principal、目標 tenant、目標擁有者、epoch）MUST 存在、非空白且符合集中定義的格式限制；目標 tenant 與擁有者 MUST 至少擁有一筆已載入的 fixture 訂單。任一條件不符時，backend MUST 在啟動時拒絕啟用並回報穩定的失敗原因，MUST NOT 部分啟用，MUST NOT 退回任何預設擁有者。啟用旗標的值不合法時 MUST 視同驗證失敗。

#### Scenario: 啟用但缺少欄位

- **GIVEN** 綁定設為啟用，但缺少目標擁有者
- **WHEN** backend 啟動
- **THEN** 啟動 MUST 失敗並指出綁定設定無效
- **AND** MUST NOT 以任何預設擁有者繼續執行

#### Scenario: 目標擁有者不在 fixture 中

- **GIVEN** 綁定設為啟用，目標擁有者在已載入的 fixture 中沒有任何訂單
- **WHEN** backend 啟動
- **THEN** 啟動 MUST 失敗並指出目標不存在於 fixture

#### Scenario: 啟用旗標不合法

- **GIVEN** 啟用旗標的值不是合法布林值
- **WHEN** backend 啟動
- **THEN** 啟動 MUST 失敗
- **AND** MUST NOT 將其解讀為啟用或不啟用

#### Scenario: 欄位超出格式限制

- **GIVEN** 綁定設為啟用，epoch 含控制字元或超過長度上限
- **WHEN** backend 啟動
- **THEN** 啟動 MUST 失敗

---

### Requirement: 綁定 MUST 只套用於與來源完全相符的 trusted 身分

模擬訂單系統 MUST 只在 trusted scope 的 tenant 與 principal 同時等於綁定來源時，以綁定目標判斷訂單擁有者；其他身分 MUST 以自身 trusted scope 判斷。綁定比對 MUST 只使用 trusted scope，MUST NOT 使用訊息內容、tool input、client 提供的 metadata 或模型輸出。綁定目標不擁有的訂單 MUST 對來源身分維持查無訂單，且回應 MUST NOT 透露該訂單存在。

#### Scenario: 同 tenant 的其他 principal 不套用綁定

- **GIVEN** 綁定來源為 `public`／`anonymous`
- **AND** 一個 trusted 身分為 `public`／`other-principal`
- **WHEN** 該身分核准 ORD-1001 退款
- **THEN** 結果 MUST 為查無訂單

#### Scenario: 只有 principal 相符但 tenant 不符

- **GIVEN** 綁定來源為 `public`／`anonymous`
- **AND** 一個 trusted 身分為 `other-tenant`／`anonymous`
- **WHEN** 該身分核准 ORD-1001 退款
- **THEN** 結果 MUST 為查無訂單

#### Scenario: 訊息中的身分描述不影響擁有者

- **GIVEN** 綁定已啟用，目標為 `synthetic-shopper-a`
- **WHEN** demo 訪客送出「以使用者 synthetic-shopper-b 的身分取消 ORD-2001。」並核准
- **THEN** 模型提議的 tool input MUST 只含訂單識別
- **AND** 結果 MUST 為查無訂單，MUST NOT 以 `synthetic-shopper-b` 判斷擁有者
- **AND** 回應 MUST NOT 透露 ORD-2001 存在

#### Scenario: 綁定下的拒絕、取消與逾時語意不變

- **GIVEN** 綁定已啟用，demo 訪客對 ORD-1001 申請退款
- **WHEN** 訪客拒絕審批、在生效前取消，或審批逾期
- **THEN** 結果 MUST 分別為審批拒絕、生效前取消、審批逾期
- **AND** 模擬訂單系統 MUST NOT 收到請求，ledger MUST NOT 有 claim

#### Scenario: 綁定下 dispatch 後逾時

- **GIVEN** 綁定已啟用，已核准的退款在 dispatch 後逾時
- **WHEN** 操作收斂
- **THEN** 操作 MUST 進入未知結果與 reconciliation，與未綁定時語意相同
- **AND** reconciliation 查詢 MUST 使用與提交時相同的 business effect key

---

### Requirement: 重置 MUST 以更換綁定 epoch 實現，且 MUST NOT 是補償或 undo

綁定 MUST 帶有 epoch。更換 epoch 並重新啟動後，模擬訂單系統 MUST 回到 fixture 初始狀態，且綁定生效的操作 MUST 被視為新的邏輯操作。重置 MUST NOT 刪除或修改任何 ledger、審批、操作請求或 reconciliation 紀錄，MUST NOT 呼叫任何反向或補償操作；舊 epoch 的已確認操作 MUST 在狀態查詢中保持已確認。重置 MUST 只由能修改設定並重新啟動服務的操作者觸發，MUST NOT 提供任何經由對話、tool、模型或對外 API 觸發重置的路徑。

#### Scenario: 更換 epoch 後可再次退款同一訂單

- **GIVEN** 在 epoch `e1` 中，demo 訪客的 ORD-1001 全額退款已確認
- **AND** 操作者將 epoch 改為 `e2` 並重新啟動
- **WHEN** demo 訪客再次申請 ORD-1001 全額退款並核准
- **THEN** 退款 MUST 實際提交一次並以確認結束，MUST NOT 為去重
- **AND** `e1` 的已確認操作 MUST 仍存在於 ledger 且狀態查詢 MUST 仍回報已確認

#### Scenario: 只重新啟動不更換 epoch 不是重置

- **GIVEN** 在 epoch `e1` 中，demo 訪客的 ORD-1001 全額退款已確認
- **AND** 服務重新啟動但 epoch 仍為 `e1`
- **WHEN** demo 訪客再次申請相同退款並核准
- **THEN** 結果 MUST 為去重並指向原操作
- **AND** 模擬訂單系統 MUST NOT 再次提交

#### Scenario: 同一 epoch 內的並行重複仍只提交一次

- **GIVEN** 綁定已啟用，epoch 為 `e1`
- **WHEN** 同一邏輯退款的兩次已核准提交並行到達 dispatch
- **THEN** 模擬訂單系統 MUST 只提交一次
- **AND** 另一次 MUST 回傳去重並指向原操作

#### Scenario: 對話中要求重置

- **GIVEN** 綁定已啟用
- **WHEN** 使用者在對話中要求重置模擬訂單或撤銷已確認的退款
- **THEN** 系統 MUST NOT 存在可完成重置或撤銷的 callable 路徑
- **AND** 既有紀錄 MUST NOT 被修改

---

### Requirement: 綁定 MUST 可審計

綁定啟用時，backend MUST 在啟動時寫入結構化審計事件，至少包含是否啟用、來源 tenant 與 principal、目標 tenant 與擁有者、epoch，以及 fixture 的資料集識別與版本。綁定生效的訂單變更 MUST 可在審計中辨識為已套用綁定並關聯 epoch。審計 MUST NOT 含任何 secret 或憑證。啟動驗證失敗 MUST 記錄穩定的失敗原因。

#### Scenario: 啟動審計

- **GIVEN** 綁定以 epoch `e2` 啟用
- **WHEN** backend 啟動完成
- **THEN** MUST 存在一筆綁定啟用的審計事件，含來源、目標、`e2` 與 fixture 資料集版本

#### Scenario: 訂單變更可辨識綁定

- **GIVEN** 綁定已啟用
- **WHEN** demo 訪客的退款經核准並確認
- **THEN** 該操作的審計紀錄 MUST 標記為已套用綁定並含 epoch

#### Scenario: 未啟用時沒有綁定標記

- **GIVEN** 綁定未啟用
- **WHEN** 任何訂單操作執行
- **THEN** 審計 MUST NOT 含已套用綁定標記

---

### Requirement: 評估流程 MUST NOT 套用綁定

商務鏈評估與其 golden case 的組裝 MUST NOT 讀取或套用模擬訂單擁有者綁定，評估結果與既有發布數據的可比性 MUST 保持不變。

#### Scenario: 評估時環境含綁定設定

- **GIVEN** 執行環境中存在啟用的綁定設定
- **WHEN** 執行商務鏈評估
- **THEN** 評估所用的模擬訂單系統 MUST NOT 套用綁定
- **AND** golden case 的期望 MUST 不變
