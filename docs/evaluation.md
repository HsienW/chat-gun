[← 回到 README](../README.md)

# 評測

**本專案評測所使用的模型**

![qwen-plus](https://img.shields.io/badge/qwen--plus-Generation-1E3A8A)
![qwen-max](https://img.shields.io/badge/qwen--max-Judge-1E3A8A)
![qwen3.7-plus](https://img.shields.io/badge/qwen3.7--plus-Flow_Generation-1E3A8A)
![text-embedding-v4](https://img.shields.io/badge/text--embedding--v4-Embedding_1024d-0EA5E9)
![qwen3-rerank](https://img.shields.io/badge/qwen3--rerank-Rerank-0EA5E9)
![pgvector](https://img.shields.io/badge/pgvector-Vector_Store-336791)

兩組評測都可重跑，並記錄資料集版本、語料版本、模型識別、prompt 版本、門檻版本、執行次數與日期。語料與訂單資料全部為合成資料，數字代表方法在受控資料集上的有效性，不代表正式環境表現。

### 檢索品質

資料集 `kb-eval-v1`（40 題，含拒答題）、語料 `kb-v1`（合成）、執行日期 2026-10-27、執行次數 1。
Embedding `text-embedding-v4`（1024 維）、Rerank `qwen3-rerank`、回答生成 `qwen-plus`。

**test split**

| 配置 | Recall@5 | MRR | 引用準確率 | 正確拒答率 | 誤拒率 | p50 ms | p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `vector_only` | 0.863 | 0.796 | 1.000 | 1.000 | 0.300 | 1651 | 3208 |
| `vector_rerank` | 1.000 | 0.917 | 1.000 | 1.000 | 0.100 | 2541 | 3552 |

**dev split**

| 配置 | Recall@5 | MRR | 引用準確率 | 正確拒答率 | 誤拒率 | p50 ms | p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `vector_only` | 0.889 | 0.744 | 1.000 | 1.000 | 0.333 | 2014 | 3121 |
| `vector_rerank` | 0.889 | 0.889 | 1.000 | 1.000 | 0.111 | 2633 | 3436 |

加入 rerank 的效果與代價都可量化：test split 上 Recall@5 由 0.863 升到 1.000、MRR 由 0.796 升到 0.917、誤拒率由 0.300 降到 0.100，代價是 p50 增加約 890ms、p95 增加約 344ms。

**指標定義**

- Recall@5 與 MRR 在套用證據門檻前，以去重後的來源排名計算（僅可回答題）。
- 引用準確率是回答中的引用能解析回檢索結果、且屬於相關來源的比例（僅已回答的可回答題）。
- 正確拒答率是拒答題中系統確實拒答的比例；誤拒率是可回答題中系統卻拒答的比例。

**方法學說明**

- 另有一項模型輔助評分的「忠實度」（回答主張被證據支持的比例）。依評測規則，該指標必須搭配至少十題人工檢查才可發布；本次重跑尚未完成人工檢查，因此**不在此處列出**。先前另一次執行完成過十題人工檢查，但評審一致率僅 0.600，不一致的案例已轉為回歸案例。
- 修正網路設定後的第一次執行有一題因 provider 錯誤中斷。依規則整次執行標記為未完成、不發布分數，上表取自重跑結果。

### 流程評測

資料集 `chain-eval-v1`（15 題、18 輪，含商品、政策、多輪、核准被拒、核准逾期、生效前取消、並行重複送出、提交後失去回應、聲稱已預先核准的注入案例）、訂單資料 `synthetic-orders-v1`（合成）。deterministic 表格執行日期 2026-10-27；live 表格執行日期 2026-11-01，完成一次。

評測分兩層：**deterministic** 層由腳本依案例預期決定路由與生成，用來驗證 runtime 的保證；**live** 層以真實模型執行路由與政策合成，`kb_search` 走真實 embedding、rerank 與知識庫，用來衡量模型品質。

**deterministic — runtime 保證**

| split | 題數（完成／通過） | 操作終端狀態正確率 | 去重原因正確率 | 引用準確率 | 正確拒答率 | 誤拒率 | 禁止結果 | p50 ms | p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| test | 10（10／10） | 1.000 | 1.000 | 1.000 | 1.000 | 0.000 | 0 | 114 | 1434 |
| dev | 5（5／5） | 1.000 | — | 1.000 | — | 0.000 | 0 | 160 | 352 |

核准被拒、核准逾期、生效前取消、並行重複送出、提交後失去回應等案例，在這一層全部產生正確且互相可辨識的終端狀態。並行重複送出的去重由腳本實際並行送出第一筆驗證，不是依序呼叫。

**live — 模型品質**

回答生成 `qwen3.7-plus`、意圖 prompt `shopping-intent-v1`、政策回答 prompt `shopping-policy-answer-v1`、訂單請求 prompt `shopping-order-request-v3`。

| split | 題數（完成／通過） | 路由準確率 | 操作終端狀態正確率 | 去重原因正確率 | 引用準確率 | 正確拒答率 | 禁止結果 | p50 ms | p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| test | 10（10／10） | 1.000 | 1.000 | 1.000 | 0.400 | 1.000 | 0 | 14970 | 83299 |
| dev | 5（5／5） | 1.000 | 1.000 | — | 0.350 | — | 0 | 14099 | 31459 |

路由混淆矩陣在 18 輪上完全落在對角線：商品查詢 2／2、政策問答 4／4、訂單操作 11／11、不支援 1／1。禁止結果 0 次。

修復前（2026-10-27，訂單請求 prompt v1）：test 通過 3／10、操作終端狀態正確率 0.222，七題都因模型未發起 Tool 呼叫而沒有走到審批閘門。結果目錄為 `chain-eval-v1-live-2026-11-01`；此前兩次嘗試都在知識庫匯入階段失敗，沒有執行任何題目。

**訂單請求 Golden 驗收**

資料集 `order-request-golden-v2`（57 則訊息，每則 5 次）、模型 `qwen3.7-plus`、溫度 0、prompt `shopping-order-request-v3`、執行日期 2026-10-31。

| 類別 | 通過／訊息 | 門檻 |
| --- | ---: | --- |
| 單筆變更 | 29／29 | 至少 95% |
| 多筆訂單 | 4／4 | 全數通過 |
| 聲稱預先核准 | 4／4 | 全數通過 |
| 對照 | 19／20 | 全數通過，已知限制除外 |

判定為**通過但有已知限制，不等於通過**。原判定是未通過，驗收規則是在看到結果後修訂，並以既有結果重新計分，沒有重新呼叫模型。回歸訊息已用於形成或修訂 prompt，未看過的訊息與 prompt 同一作者，因此不是完全獨立的樣本，也不得宣稱統計顯著。

**已知限制**

- 只是詢問可行性的訊息可能多查一次訂單狀態（`v2-feasibility-zh-cn`，5 次有 4 次）。這是唯讀查詢，不建立申請，但回覆可能不對題；變更 Tool 誤觸發為 0。
- 引用準確率偏低，且 dev 由 0.600 降到 0.350，原因尚未查明。此指標不在通過門檻內。
- 結果只適用 `qwen3.7-plus`，且 live 只完成一次。未提供原因時使用 `other`，僅限合成資料階段。

### 重跑評測

```bash
cd backend

# 產生合成語料、匯入知識庫、建立檢索評測資料集
npm run knowledge:corpus
npm run knowledge:ingest
npm run knowledge:eval-dataset
npm run knowledge:evaluate

# 流程評測
npm run commerce:eval-dataset
SIDE_EFFECT_INTEGRATION_DATABASE_URL=<隔離的資料庫> npm run commerce:evaluate -- --mode deterministic
npm run commerce:evaluate -- --mode live
```

`--mode live` 會呼叫真實模型與知識庫並產生費用。評測結果與 provenance 寫入 `backend/data/knowledge-eval/results/` 與 `backend/data/commerce-eval/results/`。任一題未完成時整次執行標記為未完成，不發布分數。

## 結果與溯源位置

評測結果與 provenance 的產出位置如上；此處沿用原 README 的已記錄結果，未重新執行評測。比較時請保留資料集、語料、模型、prompt、門檻版本、執行次數與日期，並區分 deterministic runtime 驗證與 live 模型品質。
