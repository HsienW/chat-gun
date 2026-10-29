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

資料集 `chain-eval-v1`（15 題、18 輪，含商品、政策、多輪、核准被拒、核准逾期、生效前取消、並行重複送出、提交後失去回應、聲稱已預先核准的注入案例）、訂單資料 `synthetic-orders-v1`（合成）、執行日期 2026-10-27、執行次數 1。

評測分兩層：**deterministic** 層由腳本依案例預期決定路由與生成，用來驗證 runtime 的保證；**live** 層以真實模型執行路由與政策合成，`kb_search` 走真實 embedding、rerank 與知識庫，用來衡量模型品質。

**deterministic — runtime 保證**

| split | 題數（完成／通過） | 操作終端狀態正確率 | 去重原因正確率 | 引用準確率 | 正確拒答率 | 誤拒率 | 禁止結果 | p50 ms | p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| test | 10（10／10） | 1.000 | 1.000 | 1.000 | 1.000 | 0.000 | 0 | 114 | 1434 |
| dev | 5（5／5） | 1.000 | — | 1.000 | — | 0.000 | 0 | 160 | 352 |

核准被拒、核准逾期、生效前取消、並行重複送出、提交後失去回應等案例，在這一層全部產生正確且互相可辨識的終端狀態。並行重複送出的去重由腳本實際並行送出第一筆驗證，不是依序呼叫。

**live — 模型品質**

回答生成 `qwen3.7-plus`、意圖 prompt `shopping-intent-v1`、政策回答 prompt `shopping-policy-answer-v1`。

| split | 題數（完成／通過） | 路由準確率 | 操作終端狀態正確率 | 去重原因正確率 | 引用準確率 | 正確拒答率 | 禁止結果 | p50 ms | p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| test | 10（10／3） | 1.000 | 0.222 | 0.000 | 0.300 | 1.000 | 0 | 14679 | 67256 |
| dev | 5（5／5） | 1.000 | 1.000 | — | 0.600 | — | 0 | 16049 | 35475 |

路由混淆矩陣在 18 輪上完全落在對角線：商品查詢 2／2、政策問答 4／4、訂單操作 11／11、不支援 1／1。禁止結果 0 次。

**已知限制**

live 層 test split 的七題未通過，全部是同一個現象：訂單操作回傳空的操作結果，而非預期的終端狀態（核准被拒、核准逾期、生效前取消、並行重複、提交後失去回應兩題、注入聲稱已預先核准）。這是 live 層模型輸出的問題，不是 runtime 終端狀態本身的問題 — 同一組案例在 deterministic 層全數通過，且已有針對冪等與並行的整合測試覆蓋。此限制已記錄，尚未修正。

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
