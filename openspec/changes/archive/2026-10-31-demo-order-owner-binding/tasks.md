# Tasks：Demo 訪客的模擬訂單擁有者綁定與重置（方向 A）

Primary Implementer：Codex。Secondary Architecture Reviewer：Qwen（plan 模式）。角色政策：v1（proposal D4）。
寫入範圍：`backend/**`、`docker-compose.yml`（只限 `langgraph-api` 的 environment 轉入）與本 Change 的 `tasks.md` 勾選；MUST NOT 修改 `bff/**`、`frontend/**`、`backend/data/commerce/**`、`backend/langgraph.json`、模型設定或其他 Change。

每個 Task 完成後執行：

```bash
cd backend && npm run lint && npm run test && npm run build
```

## 1. 前置確認

- [x] 1.1 以測試或紀錄確認目前行為：trusted `public`／`anonymous` 核准 ORD-1001 退款得到查無訂單（重現證據，對應 proposal「問題」）。
- [x] 1.2 確認 canonical execution context 是否提供 authority class（PrincipalKind），並在 implementation_result 記錄結果；只記錄，不自行加入比對條件（design Q2，待 review 仲裁）。
  - 驗證：測試輸出或程式位置引用附於 implementation_result。

## 2. 綁定設定與啟動驗證

- [x] 2.1 在 shopping_assistant 設定層集中讀取綁定設定（enabled、來源 tenant／principal、目標 tenant／擁有者、epoch），預設不啟用；格式限制（長度上限、安全字元集）集中定義（Requirement「綁定設定 MUST 在啟動時驗證並 fail-closed」）。
- [x] 2.2 啟動驗證：非法布林、缺欄位、空白、超出格式、目標不在 fixture 時拒絕啟用並回報穩定原因；不部分啟用、不退回預設值（design D2）。
- [x] 2.3 單元測試涵蓋 2.1–2.2 的全部情境，以及「未設定」「不啟用但其他欄位有值」維持不啟用。
  - 驗證：`cd backend && npm run test`

## 3. 擁有者綁定

- [x] 3.1 綁定只能附加在 synthetic 模擬訂單系統的組裝上；正式 provider 的組裝路徑在型別上不接受綁定（Requirement「模擬訂單擁有者綁定 MUST 只來自明確設定…」）。
- [x] 3.2 擁有者比對：trusted tenant 與 principal 同時等於來源時改以綁定目標比對；其他身分不變（Requirement「綁定 MUST 只套用於與來源完全相符的 trusted 身分」）。
- [x] 3.3 單元與 mock 測試：綁定下核准 ORD-1001 退款成功；同 tenant 其他 principal、只 principal 相符、只 tenant 相符皆查無訂單；ORD-2001 查無且不洩漏；ORD-1003 不符資格；拒絕、生效前取消、審批逾期、dispatch 前不可用、dispatch 後逾時語意與未綁定相同。
  - 驗證：`cd backend && npm run test`

## 4. business effect key 與 epoch

- [x] 4.1 綁定生效時在既有推導資料之後附加 epoch 維度；ledger 與模擬訂單系統共用同一推導（design D4；`approved-order-operations` MODIFIED「冪等鍵識別邏輯業務操作…」）。
- [x] 4.2 回歸測試：綁定未生效時推導結果與修改前逐位元組相同（以修改前的固定期望值斷言，不得只比較新函式自身）。
- [x] 4.3 測試：同 epoch 重複申請去重並指向原操作；同 epoch 並行只提交一次；更換 epoch 後以新組裝重新申請會實際提交一次，舊 epoch 的 ledger 紀錄不變；只重新組裝不換 epoch 為去重。
- [x] 4.4 確認沒有任何對話、tool、模型或對外 API 可觸發重置或修改 epoch（Requirement「重置 MUST 以更換綁定 epoch 實現…」）。
  - 驗證：`cd backend && npm run test`

## 5. 審計

- [x] 5.1 啟動時寫入綁定審計事件（是否啟用、來源、目標、epoch、fixture 資料集識別與版本）；驗證失敗記錄穩定原因；不含 secret（Requirement「綁定 MUST 可審計」）。
- [x] 5.2 綁定生效的訂單變更審計附加「已套用綁定」標記與 epoch；未啟用時無此標記。
- [x] 5.3 測試涵蓋 5.1–5.2。
  - 驗證：`cd backend && npm run test`

## 6. 評估隔離

- [x] 6.1 測試：環境中存在啟用的綁定設定時，商務鏈評估的組裝不套用綁定；golden case 檔案不變（Requirement「評估流程 MUST NOT 套用綁定」）。
  - 驗證：`cd backend && npm run test`；`git diff --stat backend/data/commerce` 必須為空。

## 7. 文件與部署設定

- [x] 7.1 `backend/.env.example`：新增綁定設定（預設不啟用），說明「重置＝更換 epoch＋重啟 `langgraph-api`」「只重啟不換 epoch 會去重」「只用於 synthetic demo，Chapter 2 由方向 B 取代」。
- [x] 7.2 `docker-compose.yml`：`langgraph-api` 的 environment 轉入綁定設定，未設定時為不啟用；不改其他服務。
  - 驗證：`docker compose config` 可解析，且未設定綁定時 `langgraph-api` 收到的值為不啟用。

## 8. 全量回歸與交付

- [x] 8.1 backend 全量 `npm run lint`、`npm run test`、`npm run build` 通過；記錄實際輸出摘要。
- [x] 8.2 implementation_result 列出：修改檔案、Git Diff 摘要、執行的命令與結果、未驗證項目（至少包含 live smoke）。

## 9. Live smoke（Master 執行；Codex 依已核准證據記錄完成）

- [x] 9.1 Docker 環境啟用綁定（epoch `e1`），在 Gun Shop 核准 ORD-1001 退款，看到確認的狀態卡片（1A-2）。
- [x] 9.2 將 epoch 改為 `e2` 並重啟 `langgraph-api`，重複 9.1 成功；再以 `e2` 重複一次得到去重。
- [x] 9.3 關閉綁定並重啟，確認回到查無訂單。

驗收紀錄：依 CCR 的 `readiness-result-001` 與 `handoff-archive-change-001`，由 Codex 歸檔時代為勾選 9.1–9.3；實際 live smoke 由 Master 執行。9.1 已確認；9.2 更換 epoch 後取得新操作編號，同 epoch 重複申請維持原編號並顯示去重；9.3 關閉綁定後為 `ORDER_NOT_FOUND`，訂單未被變更。截圖與環境設定的證據限制保留於 execution-summary.md。
