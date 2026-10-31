# Proposal：Demo 訪客的模擬訂單擁有者綁定與重置（方向 A）

## Why

### 問題

Chapter 1A 的 1A-2 需要錄製「在介面核准退款 → 冪等執行 → 狀態卡片」的端到端流程。Master 於 2026-10-29 在 Docker 環境的 Gun Shop 送出「我要申請退款，訂單 ORD-1001，商品有損壞。」後：

- 審批卡片正常出現；按下拒絕、取消申請，結果都正確。
- 按下核准後回傳 `ORDER_NOT_FOUND`，訂單沒有被變更。

根因：BFF 在 development 模式解析出的 trusted identity 為 `public` tenant、`anonymous` principal。synthetic-orders-v1 的訂單則屬於 `synthetic-tenant` 的 `synthetic-shopper-a`（ORD-1001～1004）與 `synthetic-shopper-b`（ORD-2001）。模擬訂單系統在執行階段比對 tenant 與擁有者，不符時一律回報查無訂單。比對發生在核准之後，所以審批卡片會出現，按下核准才失敗。

這個結果符合目前的規格（他人訂單 MUST 與查無訂單相同），所以不是程式缺陷，而是**產品能力尚不存在**：demo 訪客沒有任何 fixture 訂單可以操作。

### 背景

- second-stage-plan v7 r2 §3 B10：`v0.1.0` 接受所有訪客共用 `anonymous` principal，訪客之間靠無法猜測的 thread ID 隔離。
- 模擬訂單系統的狀態只存在記憶體，重啟就會遺失；冪等 ledger、審批與操作紀錄則保存在 Postgres。
- 因此「重啟服務」雖然會讓模擬訂單回到初始狀態，但同一訪客對同一訂單、同一明細再次申請退款時，ledger 會判定為去重並指向原操作，不會產生新的退款。單靠重啟無法重新錄影。

## What Changes

### 目標

1. 以**明確的 demo 設定**（不是程式碼）指定一個 trusted 來源身分（tenant＋principal）對應到 synthetic fixture 的一個擁有者；只在 synthetic 模擬訂單系統生效。
2. 以設定中的**綁定 epoch** 提供重置模擬訂單的方式：更換 epoch 並重啟後，模擬訂單回到 fixture 初始狀態，綁定身分在新 epoch 中的操作是新的邏輯操作，不會和舊 epoch 去重。
3. 設定缺漏時維持現有行為（查無訂單）；設定不完整或無效時啟動驗證失敗，不得退回任何預設擁有者。
4. 綁定與重置都可審計，且不改變任何已確認操作、ledger 紀錄或審批紀錄。

### 非目標

- 方向 B（每位訪客各自一份模擬訂單）：Chapter 2 部署前另開 Change。
- 變更 BFF 的身分解析、development identity adapter 或 canonical trusted headers。
- 新增任何 HTTP route、管理 API 或前端控制項。
- 變更 frontend 的審批卡片或狀態卡片。
- 將模擬訂單系統改為持久化。
- 變更 `commerce:evaluate`、`knowledge:evaluate` 與其 golden case 或已發布數據。
- 變更 `rolePolicyVersion` 相關的 Handoff／CurrentState schema（見「Master 決定紀錄」D4）。

## Capabilities

### New Capabilities

- `synthetic-order-owner-binding`：demo 訪客與 synthetic fixture 擁有者的設定式綁定、綁定 epoch 重置、啟動驗證、審計與 fail-closed 語意。

### Modified Capabilities

- `approved-order-operations`：
  - 「冪等鍵識別邏輯業務操作且並行重複只提交一次」：綁定生效時，business effect key 推導另外納入綁定 epoch；未生效時推導方式不變。
  - 「訂單 tool 失敗分類穩定且不洩漏他人訂單」：擁有者比對以「生效的 fixture 擁有者」為準（有綁定時為綁定目標，否則為 trusted 身分）。

## Impact

### 受影響套件

| 套件 | 影響 |
|---|---|
| backend | shopping_assistant 的模擬訂單系統組裝、擁有者比對、business effect key 推導、設定讀取與啟動驗證、審計事件、`.env.example` |
| bff | 無程式變更 |
| frontend | 無程式變更 |
| 部署設定 | `docker-compose.yml` 的 `langgraph-api` 需要轉入綁定設定（預設不啟用） |

### 受影響能力域

- Commerce：模擬訂單操作（退款申請、取消訂單）。
- Runtime Identity：只讀取 trusted scope，不修改身分解析；綁定是訂單系統層的 fixture 擁有者對應，不是身分冒充。
- Side-effect Ledger：key 推導多一個可選維度，既有紀錄與未啟用綁定時的 key 完全相容。

### 公開契約

- Graph ID、BFF route、事件格式、錯誤碼語意不變。
- 不新增錯誤碼；啟動驗證失敗是啟動錯誤，不是對外 API 錯誤。

## 風險

| 嚴重度 | 風險 | 緩解 |
|---|---|---|
| High | 綁定誤用於正式身分，把真實使用者對應到 fixture 擁有者 | 只在 synthetic 模擬訂單系統中可用；來源身分必須明確設定並與 trusted scope 完全相符；啟動時寫入審計；Chapter 2 部署前由方向 B 取代 |
| Medium | 所有 demo 訪客共用同一批訂單，一位訪客退款後其他人看到已退款或去重 | 接受（B10）；錄影前由 Master 更換 epoch 並重啟 |
| Medium | 同一 epoch 重啟後去重到舊操作，被誤認為重置失敗 | design 與 `.env.example` 明確說明「重置＝更換 epoch＋重啟」 |
| Low | 舊 epoch 未知結果的 reconciliation 在重啟後查詢新的記憶體訂單系統，回報未提交 | 既有限制（模擬訂單系統不持久化），本 Change 不改變；design 記錄 |

## 回滾策略

將綁定設定設為不啟用（或移除）並重啟 `langgraph-api`，即回到目前行為（demo 訪客查無訂單）。未啟用綁定時 key 推導與現行一致，所以既有 ledger 紀錄不需要遷移。已在綁定期間確認的操作保留在 ledger 中，不回滾。

## Master 決定紀錄（2026-10-29）

| ID | 決定 |
|---|---|
| D0 | Chapter 1A 採方向 A；方向 B 另開 Change；方向 C 不採用。 |
| D1 | 對應放在 backend 的模擬訂單系統綁定，不放在 BFF 身分解析。 |
| D2 | 重置以綁定 epoch 實現：epoch 納入綁定生效時的 business effect key，舊紀錄保留不刪。 |
| D3 | 重置的觸發方式為 Master 修改 epoch 設定後重啟 `langgraph-api`；不新增任何 endpoint 或 CLI。 |
| D4 | 本 Change 依 v1 角色政策處理（CCR 規劃、Codex 實作、Qwen 審查），`rolePolicyVersion` 尚無 schema，記錄於 coordinator_result；補 schema 列為後續 Change。 |

## 版本

屬 Chapter 1A（`v2.0.0-rc.1` 範圍）。不打 `v0.1.0` tag。
