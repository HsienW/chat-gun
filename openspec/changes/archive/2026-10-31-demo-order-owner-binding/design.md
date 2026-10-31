# Design：Demo 訪客的模擬訂單擁有者綁定與重置（方向 A）

## Context

- BFF development identity adapter 解析出 `public`／`anonymous`／`development`（`runtime-identity-permission-governance` 與 `consumer-identity` 的 development 情境，本 Change 不修改）。
- shopping_assistant 的訂單 tool 從 canonical execution context 取得 trusted scope（tenantId、scopeId、principalId），作為 requester 傳給模擬訂單系統，並以同一份 scope 推導 business effect key。
- 模擬訂單系統（in-memory）載入 synthetic-orders-v1，在提交退款或取消時比對 `tenantId` 與 `ownerPrincipalId`，不符就回報 `ORDER_NOT_FOUND`。
- Side-effect ledger 保存在 Postgres，唯一鍵為 `(tenant_id, scope_id, business_effect_key)`；business effect key 由操作種類、申請者 principal、訂單與正規化明細推導後雜湊。
- 審批、操作請求、狀態查詢都以 trusted scope（`public`／`anonymous`）記錄與讀取。

## Goals / Non-Goals

**Goals**

- G1：demo 訪客能完成「核准退款 → 冪等執行 → 狀態卡片」。
- G2：綁定只來自明確設定，只在 synthetic 模擬訂單系統中生效。
- G3：可重複錄影：更換 epoch 並重啟後得到乾淨的 fixture 與新的邏輯操作。
- G4：不改變身分層、BFF、frontend 與既有 ledger 紀錄的語意。

**Non-Goals**：見 proposal「非目標」。

## 各層變更

### frontend

無變更。審批卡片與狀態卡片沿用既有事件；退款成功後的狀態卡片由既有流程產生。

### bff

無變更。BFF 繼續以 development adapter 解析 `public`／`anonymous`，不承擔任何訂單擁有者邏輯（bff/AGENTS.md §3）。

### backend

1. **設定讀取與驗證**（集中在 shopping_assistant 的設定層，啟動時執行）。
2. **擁有者綁定**：只作用於 synthetic 模擬訂單系統的擁有者比對。
3. **business effect key 推導**：綁定生效時加入 epoch 維度。
4. **審計**：啟動時記錄綁定狀態；訂單變更的審計紀錄可關聯 epoch。
5. **文件與部署設定**：`.env.example` 說明、`docker-compose.yml` 轉入設定（預設不啟用）。

## Decisions

### D1：綁定放在 backend 的模擬訂單系統層，不放在 BFF（Master 已決定）

- 採用理由：
  - 身分層保持「anonymous 就是 anonymous」，不需修改 identity spec 的 development 情境，也不影響 chatbot、deep_researcher 的 audit 與 scope。
  - 綁定的語意是「這個 synthetic 資料集裡，哪個 fixture 擁有者代表 demo 訪客」，屬於 fixture 的組裝設定，而不是「誰是這個使用者」。
  - backend 只消費 BFF 產出的 trusted scope，不信任訊息內容或 tool input（訂單 tool 的 input 本來就拒絕身分欄位）。
- 替代方案：BFF demo resolver 直接把訪客解析成 `synthetic-tenant`／`synthetic-shopper-a`。不採用：需修改兩份 identity spec 的 MUST，且等同於在身分層冒充 fixture 使用者。
- 結果：同一次操作有兩種視角，design 明確規定：
  - **trusted 視角**（`public`／`anonymous`）：審批、操作請求、ledger 的 tenant／scope、狀態查詢、去重範圍、audit 的 principal。
  - **fixture 視角**（綁定目標）：只用於模擬訂單系統判斷「這筆訂單是否屬於申請者」與「是否符合資格」。
  - 模擬訂單系統的回傳結果（效果事實）不帶任何身分欄位，所以兩種視角不會互相污染。

### D2：設定形狀與啟動驗證

設定（名稱由實作決定，以下為語意欄位）：

| 欄位 | 說明 |
|---|---|
| enabled | 是否啟用；預設不啟用 |
| sourceTenantId | 要綁定的 trusted tenant（例如 `public`） |
| sourcePrincipalId | 要綁定的 trusted principal（例如 `anonymous`） |
| targetTenantId | fixture 中的 tenant（例如 `synthetic-tenant`） |
| targetOwnerPrincipalId | fixture 中的擁有者（例如 `synthetic-shopper-a`） |
| epoch | 綁定 epoch；重置時更換 |

啟動驗證規則：

- 未設定或 enabled 為不啟用：不建立綁定，其他欄位忽略；行為與現行一致（demo 訪客查無訂單）。
- enabled 的值不是合法布林字串：啟動失敗。
- 啟用但任一欄位缺漏、空白或超出格式限制（長度上限與安全字元集，由實作在設定層集中定義並測試）：啟動失敗。
- 啟用但載入的 fixture 中沒有任何訂單同時符合 `targetTenantId` 與 `targetOwnerPrincipalId`：啟動失敗。
- 啟用但 fixture 不是 synthetic provenance：不可能發生（既有 fixture schema 已拒絕），仍以型別保證綁定只能附加在 synthetic 模擬訂單系統上，正式 provider 的組裝路徑不接受綁定。
- 任何失敗 MUST NOT 退回預設擁有者、MUST NOT 部分啟用。

選擇「無效時啟動失敗」而非「無效時維持查無訂單」的理由：backend/bff AGENTS.md 要求設定對缺失或非法值快速失敗；操作者明確想啟用卻設定錯誤時，啟動失敗比靜默查無訂單更容易發現。兩者都是 fail-closed，都不會讓任何人取得 fixture 訂單。此點列為 review 重點，Master 可改判。

### D3：綁定的比對條件

- 只有當 trusted scope 的 `tenantId` 與 `principalId` **同時**等於 `sourceTenantId`／`sourcePrincipalId` 時，模擬訂單系統才以 `targetTenantId`／`targetOwnerPrincipalId` 作為擁有者比對對象。
- 其他 principal（包括同 tenant 的其他 principal、已認證帳號）一律以自身 trusted scope 比對，不套用綁定。
- 綁定是一對一：一份設定只有一個來源與一個目標。
- 訊息內容中的身分描述不會進入 tool input（既有 schema 拒絕），也不會進入綁定比對；golden case `order-v1-08` 的期望不變。
- 綁定目標不擁有的訂單（例如 ORD-2001 屬於 `synthetic-shopper-b`）對 demo 訪客仍為查無訂單，且回應不透露存在。

### D4：epoch 重置與 business effect key（Master 已決定）

- 綁定生效（D3 條件成立）時，business effect key 的原始推導資料在既有元素之後**附加**綁定 epoch 維度；ledger 與模擬訂單系統使用同一個推導函式，維持兩邊 key 一致（現行設計已如此）。
- 未生效時（未啟用或 principal 不符），推導結果與現行**逐位元組相同**，既有 ledger 紀錄不需遷移。
- epoch 不是 attempt、tool call、run 識別或自由文字理由，符合「冪等鍵識別邏輯業務操作」的排除條件。
- 同一 epoch 內：並行去重、已確認後去重、跨對話去重等既有語意完全不變。
- 不同 epoch：同一訂單、同一明細的申請是不同的邏輯操作，會實際提交一次。

重置流程（D3，Master 已決定）：

1. Master 修改 epoch 設定。
2. 重啟 `langgraph-api`。
3. 模擬訂單系統重新載入 fixture（初始狀態）；新 epoch 生效；啟動審計記錄新 epoch。

語意說明：

- 「只重啟、不換 epoch」**不是重置**：模擬訂單回到初始狀態，但 ledger 仍會把同一邏輯操作判定為去重並指向原操作。這是正確的冪等行為，`.env.example` 必須說明。
- 重用舊 epoch：會與該 epoch 的舊操作去重。這不會損壞資料，只是錄影時要避免；不強制 epoch 單調遞增（沒有持久狀態可比較，也不需要）。
- 重置**不是補償或 undo**：不刪除、不修改任何 ledger、審批、操作請求或 reconciliation 紀錄，也不呼叫任何反向操作；舊 epoch 的已確認操作在狀態查詢中仍可見並保持已確認。符合 `approved-order-operations`「不提供 undo 或補償」。

### D5：審計

- 啟動時寫入一筆結構化審計事件：綁定是否啟用、來源 tenant／principal、目標 tenant／擁有者、epoch、fixture datasetId／datasetVersion。不含任何 secret。
- 綁定生效的訂單變更，其既有審計紀錄附加 epoch 與「已套用綁定」標記，讓事後能區分 demo 綁定操作與一般操作。
- 啟動驗證失敗時記錄失敗原因的穩定代碼（不含原始設定值以外的內部資訊）。

### D6：評估流程不受影響

`commerce:evaluate` 自行組裝模擬訂單系統與身分，不讀取綁定設定；golden case 與已發布數據不變。實作 MUST 以測試證明評估組裝路徑不套用綁定。

## 資料流

```text
Browser → BFF（development adapter：public / anonymous）
  → backend shopping_assistant
    → 訂單 tool：讀 trusted scope（public / anonymous）
      → key 推導：scope 相符且綁定啟用 → 附加 epoch
      → 審批（trusted 視角）→ 核准 → dispatch
        → 模擬訂單系統：scope 相符 → 以綁定目標比對擁有者
        → 效果事實（無身分欄位）
      → ledger（tenant/scope = public/anonymous，key 含 epoch）
    → 狀態卡片（既有事件）
```

## 失敗、逾時與取消

| 情境 | 綁定生效時的結果 |
|---|---|
| 審批拒絕／逾期 | 與現行相同；不呼叫模擬訂單系統，ledger 無 claim |
| 等待審批時取消 | 與現行相同；`CONFIRMATION_CANCELLED`，ledger 無 claim |
| dispatch 前訂單系統不可用 | 與現行相同；未提交失敗，不轉成查無訂單 |
| dispatch 後逾時或回應遺失 | 與現行相同；進入 reconciliation（key 含 epoch，查詢一致） |
| 訂單不屬於綁定目標 | 查無訂單，不洩漏存在 |
| 不符資格（例如 ORD-1003 已過退款期限） | 不符資格 typed failure |

## 測試策略

- Deterministic unit：設定解析與驗證（未設定、不啟用、非法布林、缺欄位、格式超限、目標不在 fixture）；比對條件（相符、只 tenant 相符、只 principal 相符、其他 principal）；key 推導（未生效與現行相同、生效時含 epoch、不同 epoch 不同 key、同 epoch 相同 key）。
- Mock integration：綁定下核准退款成功且 ledger 一筆；同 epoch 重複申請去重；換 epoch（新組裝）後同一申請實際提交；他人訂單查無；拒絕／取消／逾時不變；評估組裝不套用綁定。
- 既有回歸：backend 全量 lint／test／build；訂單 tool、ledger、shopping_assistant 相關測試全數通過。
- Live smoke（Master）：Docker 環境依 1A-2 流程核准 ORD-1001 退款並看到狀態卡片；更換 epoch 並重啟後再錄一次。

## Risks / Trade-offs

- 兩種視角（D1）增加理解成本：以審計標記與 design 說明緩解。
- 共用訂單（B10）：接受；方向 B 處理。
- 舊 epoch 未知結果的 reconciliation：模擬訂單系統不持久化的既有限制，重啟後 lookup 會回報未提交。本 Change 不改變此行為，只記錄。

## Migration / Rollback

- 無 schema 或資料遷移；未啟用綁定時 key 與現行相同。
- 回滾：關閉綁定並重啟。

## Open Questions（已定案）

- Q1（已定案）：未設定維持查無訂單；啟用但無效則啟動失敗。
- Q2（已定案）：不納入 `principalKind`，只比對 `tenantId` 與 `principalId`；於方向 B 或引入 authenticated 身分前重新評估。
