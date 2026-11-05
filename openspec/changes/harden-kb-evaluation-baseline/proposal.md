# Proposal：1B-2 重跑前修正知識庫評測量測

## Why

Chapter 1B-2 會用 qwen3.5-flash 重跑知識庫評測，v7 的 D8 排有混合檢索，需要先有凍結的 Baseline。目前的量測有三個問題；先修正再重跑，可以避免重複花費。

### 問題一：Rerank 延遲無法發布

每題的 `latencyMs` 是整題經過時間，包含 embedding、召回、rerank、回答生成與 Judge。`vector_only` 與 `vector_rerank` 的差異混入兩次不同的模型生成，所以報表上的 P50／P95 不能當作 Rerank 延遲。

`kb-eval-v1-2026-10-27-r2` 的 test split：`vector_only` P50 1651 ms、`vector_rerank` P50 2541 ms。差值 890 ms 不是 Rerank 延遲。

### 問題二：資料集無法作為混合檢索的 Baseline

`kb-eval-v1` 只有 40 題，test 可答題 20 題，`sku_lookup` 全部只有 4 題（dev、test 各 2），`multi_answer` 只有 1 題。下列條件都不足以判斷混合檢索是否有效：

- **精確查詢缺口已存在但樣本太少。** `prd-08`（YM-1013）在 `vector_only` 與 `vector_rerank` 的 Recall@5 都是 0，已保存的前 10 名都是其他瑜伽墊。這是純向量的精確查詢缺口，但它在 dev split，不進 test 分數。
- **來源跨分割。** `policy-return-window` 等來源同時出現在 dev 與 test，而 `kb-threshold-v1` 是用 v1 dev 校準的。
- **沒有同系列干擾的量測。** 語料有 54 個同系列組，另有 20 組標題相同、SKU 不同的商品，v1 沒有專門題型。

### 問題三：單一總分會掩蓋分層差異

報表只有一列總分。加入大量模板題後，混合檢索可能只因模板題含 SKU 字面而拉高總分，卻被讀成整體提升。

## What Changes

### 目標

1. 把每題延遲拆成 embedding、召回、rerank、生成與 Judge，並能發布 Rerank 延遲。
2. 新增 `kb-eval-v2`：約 90 題（語料自動生成 60、人工撰寫 30），涵蓋 SKU、同系列商品、多答案、near_miss、跨語言、跨來源；同一來源只在同一分割；在實作混合檢索前凍結。
3. 報表依來源（模板／人工）與標籤分層，模板題分數不得當作整體提升。
4. 報表聲明評測使用原始問題，與線上由模型組 Query 不同。

### 非目標

- 不修改 `kb-eval-v1`、其建構腳本的輸出與既有結果。
- 不執行 1B-2 live 重跑，不切換生成模型。
- 不實作混合檢索、不改 `retrieveCandidates` 的行為，也不重新校準 `kb-threshold-v1`。
- 不修改語料 `kb-v1`、`kb_search` Tool Schema 或線上檢索。
- 不量測線上 Query 組裝品質；本 Change 只聲明差異（見 design D7）。
- 不修改 `backend/src/evaluation/commerce/*` 與 `backend/package.json`。新增 npm script 列為 F-L1 提交後才做的選做任務；沒有它也能執行全部流程。

## Capabilities

### Modified Capabilities

- `retrieval-evaluation`：新增階段延遲、`kb-eval-v2` 資料集契約與凍結、分層報表、模板題聲明限制與 Query 差異揭露。全部是 ADDED Requirements，不修改既有 Requirement，與 `fix-order-request-tool-initiation` 對同一 capability 新增的三項 Requirement 沒有重疊，歸檔順序不影響結果。

## Impact

- **受影響套件**：僅 `backend` 的知識庫評測與其資料檔。Frontend、BFF 無變更。
- **能力域**：知識庫檢索評測。
- **契約**：評測結果 JSON 與 provenance 只增加向後相容欄位；`latencyMs` 語意不變。`eval_case@1` 不升版，新欄位走既有的未知欄位保留機制。不新增 Graph、Tool、BFF 契約。
- **相鄰程式**：`chain-case` 匯入 `eval-case` 的常數，`chain-scoring` 匯入 `scorers`；兩者的既有匯出不得變動。
- **成本**：v2 一輪的模型呼叫約為 v1 的 2.25 倍（90／40），由 1B-2 支出，本 Change 不產生 live 費用。

## Risks

- **「人工」題由 Agent 起草**：v1 的 `hand-written` 同樣如此。v2 記錄作者並要求 Master 審閱後才能凍結；若未審閱，不得標示為人工審閱（見 design D3）。
- **人工分層樣本仍小**：每個標籤在 test 的人工題下限只有 5 題，一題就差 0.2。報表必須顯示 n，且差異小於一題解析度時不得視為提升。
- **模板題含 SKU 字面，對詞彙檢索有利**：這正是分層與聲明限制要防的偏誤，不靠調整模板消除。
- **凍結後發現資料集錯誤**：只能發新版本，已發布的 v2 結果仍保留。因此凍結前有程式化 ground truth 檢查與 Master 審閱。
- **延遲含冷啟動與本機網路**：序列執行時第一題含連線建立，數字僅反映評測環境，不代表正式環境（見 design D1）。

## Rollback

還原評測程式與新增資料檔。結果 JSON 新欄位為可選，舊讀取者不受影響；沒有資料遷移，線上流程沒有變更。
