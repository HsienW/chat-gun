# Design：1B-2 重跑前修正知識庫評測量測

## 問題層級

失敗層級是評測工具與資料集，不是 Resolver、Provider 或 Graph。線上流程沒有變更。

| 層 | 變更 |
|---|---|
| frontend | 無 |
| bff | 無 |
| backend 線上檢索（`retrieval.ts`、`kb_search`） | 無 |
| backend 評測（`knowledge/evaluation/*`、`scripts/knowledge/*`、`data/knowledge-eval/*`） | 本 Change |

Tool 與權限：不新增、不修改 Tool 或 MCP，沒有新的權限面。唯一新輸入是 CLI 的 `--dataset`（見 D6）。

## 實作基準

本規劃 Session 的 worktree 位於 `aaba3a3`，比主工作樹分支 `feat/4.6.5-feat/lane-knowledge-retrieval`（`740cc4e`）少 138 個 commit。實作 MUST 以該分支為基準（含 `degradationEgress*` 與 chain-eval 改動），不得基於 `aaba3a3`。下列引用的程式碼都已對照 `740cc4e` 確認：

- `runner.ts` 的 `latencyMs` 涵蓋整題，包含合成與 Judge。
- `chain-case.ts` 匯入 `eval-case.ts`，`chain-scoring.ts` 匯入 `scorers.ts`；兩者的既有匯出不得改動。
- `evaluate.cli.ts` 寫死 `kb-eval-v1.json`。
- `build-inspection-template.ts` 也寫死 v1；它只服務舊結果，本 Change 不改。CLI 已會為新執行直接輸出抽查模板。

## D1 階段延遲：在 Runner 包裝依賴，不改檢索

`evaluateCase` 每題建立一個階段記錄器，用裝飾器包裝 `input.gateway`（`embed`、`rerank`）、`input.store`（`recall`）、`synthesizer`、`judge`，再傳入既有流程。計時使用既有的 `input.now`，讓測試可用假時鐘。

```ts
type StageTiming =
  | { status: "completed"; ms: number }
  | { status: "failed"; ms: number }
  | { status: "not_run" };

type StageLatency = Record<"embedding" | "recall" | "rerank" | "generation" | "judge", StageTiming>;
```

`CaseResult` 兩種狀態都新增可選的 `stageLatency`。`latencyMs` 維持整題總時間，既有讀取者不受影響。

彙總：`SplitSummary` 新增每階段的 `{ completed, failed, notRun, p50Ms, p95Ms }`，P50／P95 只用 `completed` 的量測，並只計已完成案例；另加 `retrievalP50Ms`、`retrievalP95Ms`，為 embedding、召回與 rerank 之和，含失敗的 rerank 耗時，因為使用者實際要等那段時間。

**替代方案**

| 方案 | 不採用原因 |
|---|---|
| 在 `retrieveCandidates` 內加計時並回傳 | 改動線上共用路徑與回傳型別，違反非目標 |
| 使用 `KnowledgeUsageEvent.latencyMs` | 只有 HTTP gateway 有，不含 store、生成與 Judge，假實作也無法驗證 |
| 兩組設定總延遲相減 | 混入不同的生成呼叫，正是要解決的問題 |

**限制**：Runner 是序列執行，不受並行干擾；但第一題的召回含連線建立，`vector_only` 通常先跑。P95 對此敏感度較高。報表聲明數字反映評測環境與網路，不代表正式環境。不加暖機邏輯，避免多一個需要驗證的分支。

## D2 v2 的案例欄位：沿用 `eval_case@1`

v2 不升版契約。`eval_case@1` 已保證未知欄位保留，升版會牽動 `chain-case` 的版本路由。新增欄位：

| 欄位 | 用途 |
|---|---|
| `provenance.origin` | `template` 或 `hand_authored` |
| `provenance.authoredBy` | 人工題的實際作者，例如 `agent:codex`、`human:master` |
| `expected.seriesSiblingSourceIds` | `same_series` 的同系列商品 |
| `expected.groundTruthRule` | `multi_answer` 的查詢規則（品類、功能、價格上限等） |
| `expected.nearMissSourceIds` | `near_miss` 的最接近來源 |
| 資料集層 `freezeRequired: true` | CLI 據此要求凍結紀錄（D5） |

讀取來源類別時用 zod 驗證；未知值與缺值都回傳 `unclassified`。報表因此不會把舊案例推測為人工。

標籤沿用 v1 的 `cross_lingual` 拼法（含拼字錯誤），讓分層能跨版本對照。新增 `same_series`、`cross_source`。必要標籤是封閉清單，符合 AGENTS.md 第 6 節允許的 Domain Constant：有單一來源、有型別、有測試，且不承擔自然語言理解；報表的分層清單由資料推導，不限於這份清單。

## D3 題目來源與組成

目標總數 90：模板 60、人工 30；dev 30、test 60。

| 標籤 | 模板 dev／test | 人工 dev／test | 題型 |
|---|---|---|---|
| `sku_lookup` | 6／13 | 與其他題重疊 | 以 SKU 問規格 |
| `same_series` | 3／9 | 2／5 | 指明 SKU，答案在同系列間不同 |
| `multi_answer` | 2／6 | 2／5 | 品類＋功能＋價格，2–5 個答案 |
| `near_miss` | 2／6 | 3／5 | 虛構 SKU、同系列不存在的型號或語料未涵蓋的細節 |
| `cross_source` | 2／5 | 3／5 | 商品＋政策或 FAQ，例如 finalSale＋政策 |
| `cross_lingual` | 5／1 題專屬＋至少 4 題同時帶 `sku_lookup`（含在 `sku_lookup` 的 13 題內，不另計題數） | 與其他題重疊 | 繁中與簡中問英文語料 |

表中模板數量是目標；重疊後實際分配由建構腳本決定，只要 spec 的下限成立。為達到人工 test 每標籤 5 題，20 題人工 test 平均帶 1.5 個標籤。Spec 的總量範圍（模板 55–65、人工 27–33）留給 ground truth 檢查排除無效題時使用，不得用來規避任何標籤下限。

**模板題**：由新建構腳本從語料結構化欄位以固定種子確定性產生，答案由語料計算，不呼叫模型。v1 的建構腳本與輸出不改。系列定義為同品牌、同品類、標題去掉最後一個詞相同（語料生成器的格式是 `${brand} ${noun} ${suffix}`）。語料含重複與雜訊紀錄，系列與 SKU 的判定 MUST 使用 `prepareCorpus` 去重後的來源集合。

**人工題**：由 Implementer 起草，避免使用語料原句與 v1 題目，並記錄 `authoredBy`。

> **決策**：v1 的「hand-written」實際由 Agent 撰寫，若 v2 沿用同樣標籤會誇大人工程度。因此 v2 欄位名為 `hand_authored`，實際作者如實記錄，凍結前必須有 Master 審閱紀錄。報表顯示作者分布。Master 若希望由本人撰寫，只需替換題目，流程不變。

起草與審閱期間 MUST NOT 跑任何檢索。審閱依據只有語料與程式化檢查，否則題目會被結果污染。

## D4 分割：先切語料，再由題目取樣

建構腳本先把來源分區，再各自取樣，而不是產生題目後才分配：

1. 同系列組視為一個單位。
2. v1 dev 的相關來源（執行時由 v1 檔案推導，不寫死）所屬單位固定到 v2 dev。
3. 其餘單位以固定種子分配。政策與 FAQ 明確分配，確保 test 仍有足夠政策可組 `cross_source`。例如 `policy-final-sale`、`policy-warranty` 都在 v1 dev，故落在 v2 dev；test 用 `policy-damaged-defective`、`policy-exchanges`＋`faq-size-guide` 等。
4. 虛構 SKU 的 near_miss 使用該分區內的最接近來源。

組成驗證獨立以 union-find 確認：相關來源、最接近來源、同系列商品的連通分量不得跨分割。驗證器不依賴建構腳本，手改資料也會被擋下。

**影響**：`prd-08`（YM-1013）屬 v1 dev 來源，所以 YM-1013 與其系列只會在 v2 dev；精確查詢缺口在 v2 test 由其他 SKU 量測。這符合隔離目的，不特別為它開例外。

## D5 凍結

產物是 `kb-eval-v2.json` 與 `kb-eval-v2.freeze.json`：

```json
{
  "datasetVersion": "kb-eval-v2",
  "contentSha256": "...",
  "caseCount": 90,
  "frozenAt": "...",
  "review": { "reviewedBy": "Master", "reviewedAt": "...", "note": "..." }
}
```

- 雜湊對**解析後的正規化 JSON** 計算，不對原始位元組，避免 Windows CRLF 造成假警報。
- `review` 只有在 Master 於聊天中明確確認後，Implementer 才可依確認內容寫入，並在 implementation_result 引用該次確認。Agent 不得自行推定已審閱。
- CLI 在建立任何模型物件之前驗證，錯誤碼 `EVAL_DATASET_NOT_FROZEN`、`EVAL_DATASET_HASH_MISMATCH`。
- 測試固定 v2 與凍結紀錄一致，同時固定 v1 的內容雜湊，防止 v1 被改動。

順序：**凍結 → 1B-2 重跑（Baseline）→ D8 混合檢索**。

v1 仍保留做語意查詢對照：v2 刻意偏向精確查詢與干擾題，混合檢索對純語意查詢是否退化要看 v1。因此 D8 應兩份都跑。v1 與 v2 的分數不得相互比較。是否在 1B-2 同時重跑 v1，由 1B-2 決定；要與既有 qwen-plus 數字比較就必須跑。

## D6 CLI

`npm run knowledge:evaluate -- --dataset kb-eval-v2`。npm 已會轉送參數，所以不需要改 `package.json`。未指定時維持 v1。名稱 MUST 符合 `^kb-eval-v[0-9]+$`，並組成 `data/knowledge-eval` 內的路徑，防止路徑穿越。

v2 資料集建構在 F-L1 提交前以 `npx tsx scripts/knowledge/build-eval-dataset-v2.ts` 執行。

## D7 離線與線上的 Query 差異

| 項目 | 評測 | 線上 `kb_search` |
|---|---|---|
| Query | `item.input.question` 原文 | 模型組的 `query` 參數 |
| `topK`、`sourceTypes` | 預設值、不過濾 | 模型可指定 |
| 跨語言 | 不翻譯，中文直接比對英文語料 | 模型可能改寫或翻譯 |
| 回答 Prompt | `kb-answer-v1` | 線上 Agent Prompt |

因此：

- 評測量到的是**檢索器對原始問題的能力**，不是線上端到端品質。
- 差異方向沒有固定：`cross_lingual` 可能低估線上結果（模型會翻譯），SKU 題可能高估（模型可能在 Query 中遺漏 SKU）。不得用離線分數推論線上方向。
- 混合檢索的 Baseline 使用原始問題是有意選擇：Query 由模型組裝時，分數會混入模型版本變異，切換 qwen3.5-flash 後也無法與前次比較。

provenance 新增 `queryMode: "raw_question"`，報表加入聲明。線上 Query 的量測不在本 Change；若要驗證，應另開 Change，把線上 Query 錄製後重放進檢索。

## D8 分層報表與提升判定

`CaseResult` 新增可選的 `tags`、`origin`（由 Runner 從案例複製，報表不需再讀資料集）。`EvaluationRun` 新增可選的 `strata`：依分割列出 `origin:*` 與 `tag:*` 的 `SplitSummary`。

每份 `comparison-<split>.md` 的順序：

1. 可發布狀態。
2. **提升判定**：只比較人工題分層，顯示差異與 n。
3. 來源分層：人工、模板（診斷用）、未分類。
4. 標籤分層：每個標籤一列，顯示可回答與拒答 n。
5. **混合總分**：既有的表，標題改為混合總分且不可作為提升依據。
6. 階段延遲。
7. 定義與 provenance。

提升判定以第一組設定為基準，只在下列條件都成立時輸出判定：兩次執行都完成、內容雜湊相同、n ≥ 5。差異小於 1/n 時標示解析度內。門檻 5 是 `MIN_CLAIMABLE_STRATUM_CASES` 常數。報表不輸出統計顯著性：這個樣本量不足以支撐，也不增加新依賴。

既有 `row()` 的降級次數是對整個 run 計算，而不是該分割。例如 `kb-eval-v1-2026-10-23-r3` test 表的「degraded 1」可能來自 dev。新分層 MUST 只計該分層；同時修正該 helper，既有 run 檔不重新渲染，不影響既有結果。

v1 指標的計算不變；用 v1 重跑時，來源類別顯示未分類，提升判定顯示沒有人工題分層。

Opik：`caseScores` 加入 `stageLatency`、`tags`、`origin`。Opik 上傳已會在未完成時略過，行為不變。

## 與進行中工作的關係

| 工作 | 邊界 |
|---|---|
| `fix-order-request-tool-initiation`（F-L1） | 對 `retrieval-evaluation` ADDED 三項 Requirement，都是鏈路評測與 Golden，名稱與語意不重疊。本 Change 也只有 ADDED，歸檔順序無關。檔案不重疊：F-L1 改 `src/evaluation/commerce/*`、`order-branch*`、`package.json`；本 Change 只改 `src/knowledge/evaluation/*` 並新增資料與腳本。 |
| `demo-cost-and-access-guard` | 不涉及評測。 |
| 主規格的鏈路 Requirement | 已存在於 `740cc4e`，本 Change 不修改。 |

F-L1 的 Golden 凍結做法（鎖定雜湊、改動就換版本）與 D5 一致。

## Risks / Trade-offs

- **組成下限在語料上無法達成** → 下限是依語料統計估算（200 商品、54 系列、20 政策、10 FAQ），尚未以程式驗證。無法達成時 Implementer 停止並回報 CCR，不得自行降低。
- **v1 dev 來源隔離限制 `cross_source` 可用政策** → D4 已列出 test 可用政策；若不足，回報 CCR。
- **`SplitSummary` 新增欄位破壞 `toEqual`** → 若既有測試斷言完整物件，更新斷言須說明是欄位新增，不得放寬其餘內容。
- **`P50 ms` 欄位更名** → 既有測試如斷言欄名，只改欄名本身。
- **人工審閱成為凍結瓶頸** → 這是有意的 Gate。審閱前其他任務都能完成，只有凍結與 1B-2 需要等。
- **live 驗證缺口** → 本 Change 的驗證都是 deterministic。第一次真實模型下的階段延遲由 1B-2 取得，不得在完成回報中宣稱已 live 驗證。

## Migration Plan

新增欄位皆為可選，沒有遷移。既有結果不重新渲染。回滾見 Proposal。
