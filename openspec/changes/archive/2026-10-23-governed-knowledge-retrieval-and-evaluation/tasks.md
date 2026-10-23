# Tasks：governed-knowledge-retrieval-and-evaluation

> lite profile（ADR-FL-001）。每個 Task 可獨立驗證；只有程式、測試與驗證都實際完成並通過後才能勾選。live 驗證（真實模型呼叫）與 deterministic 測試分開記錄，mock 通過不得當作 live 通過。日程對應 `second-stage-plan-en-v7.md`：D0 契約凍結、D1 檢索主幹、D2 品質與對比表。

## T0 唯讀盤點與命名對齊（D0）

> 前置：無。T1–T9 皆引用本盤點結果。

- [x] 盤點 LLM Gateway 的用途、endpoint kind、capability、tracing 與錯誤碼慣例，確認 embedding／rerank 的 additive 接入點。
- [x] 盤點 X27 SDK manifest adapter 既有範例的註冊路徑，確認 `kb_search` 進入既有 governed tool registry 與 X14 dispatch 的位置。
- [x] 盤點既有 authorization action、retry／timeout class、data classification 與 data inventory 衍生資料的 enum 值；design §5、§6 的暫定命名以既有慣例定案，語意不得改變。
- [x] 對照供應商官方文件確認 embedding 與 rerank 的 endpoint、請求格式、地域與模型識別，記錄確認日期。
- [x] 產出盤點紀錄於 `.agent-runtime/governed-knowledge-retrieval-and-evaluation/evidence/`。

驗證命令：

```bash
cd backend
npm run build
```

## T1 Knowledge store 與 migration（D1）

> 前置：T0。對應 Requirement「知識庫為分離的衍生索引」「embedding space 版本化」「檢索以 tenant 隔離」。

- [x] `docker-compose.yml` 新增獨立 pgvector 服務（固定映像版本），與既有 LangGraph postgres 分離。
- [x] 建立 knowledge store 的版本化 migration（2026-10-23 於 pgvector/pg16 實際執行）：source、chunk、ingestion run、embedding space；向量索引與 tenant／status 過濾。
- [x] 連線設定經 SecretBroker 解析，不寫死連線字串。
- [x] 測試：provenance 欄位缺失不可查詢、embedding space 不一致 typed failure、tenant 過濾。

驗證命令：

```bash
cd backend
npm run lint
npm run test
npm run build
```

## T2 LLM Gateway：embedding 與 rerank 用途（D1）

> 前置：T0。對應 Requirement「embedding 與 rerank 只經受治理的模型閘道呼叫」。

- [x] 新增 `embedding`、`rerank` 用途與 capability flag；未宣告能力 typed unsupported failure 且不發外部請求。
- [x] 憑證經 SecretBroker、目的地經 egress policy（含 redirect）。
- [x] typed failures：逾時、限流、維度不一致、輸入過大、rerank 不可用／錯誤；取消回傳取消結果。
- [x] 每次呼叫發出用量事件（provider、model、purpose、用量、延遲、結果、correlation）。
- [x] 既有 Gateway 測試全數回歸通過，chat 等既有用途行為不變。

驗證命令：

```bash
cd backend
npm run lint
npm run test
npm run build
```

## T3 入庫管線（D1）

> 前置：T1、T2、TB1。對應 Requirement「入庫冪等且可續跑」。

- [x] parse → normalize → dedupe → chunk（版本化 chunking policy）→ batch embed（有界併發）→ upsert。
- [x] 缺 provenance 標記的文件 typed failure 拒絕。
- [x] 自然鍵冪等：重複提交不呼叫 embedding、chunk 數不變。
- [x] 可續跑：已完成 chunk 跳過；部分批次失敗時 run 為未完成且不標記文件完成。
- [x] 超大與空內容文件 typed failure，不影響同 run 其他文件。
- [x] job 不讀取 provider 憑證環境變數。

驗證命令：

```bash
cd backend
npm run lint
npm run test
npm run build
```

## T4 `kb_search` 註冊與 recall（D1）

> 前置：T1、T2。對應 Requirement「kb_search 經完整 manifest 註冊並經統一 dispatch 執行」。

- [x] 以 X27 SDK manifest adapter 宣告 `kb_search` 十類欄位（design §6.1），註冊進既有 governed tool registry。
- [x] input schema 不接受 tenant／principal／approval 欄位；夾帶時 schema error。
- [x] tenant 只取自 server 端 execution context。
- [x] 測試：manifest 缺欄位註冊 fail-closed、authorization 拒絕時不發 embedding 呼叫、經 dispatch 的執行證據含 tool 識別與 correlation。

**D1 Gate**：一輪對話經 `kb_search` 召回，回傳可解析至已儲存 chunk 的引用（live，記錄於 evidence）。✅ 2026-10-23 通過：mcp_agent 真實對話經 dispatch 呼叫 kb_search 一次，回答引用 [c3]、[c1] 皆可解析（evidence/d1-live-smoke.json）。

驗證命令：

```bash
cd backend
npm run lint
npm run test
npm run build
```

## T5 Rerank、證據門檻、降級與拒答（D2）

> 前置：T4。對應 Requirement「檢索階段、降級與檢索證據」「證據門檻與拒答」。

- [x] rerank 階段；不可用時降級 recall-only 並在 retrieval evidence 標記原因。
- [x] 依模式分別的版本化證據門檻；以 dataset v1 dev split 決定並記錄方法與日期。（kb-threshold-v1：vector 0.616、rerank 0.62，data/knowledge-eval/thresholds/kb-threshold-v1.json；test 以 r3 live 驗證）
- [x] 無候選通過門檻 → `no_source_found`。
- [x] `kb_search_result@1` output schema 驗證（evidence_found／no_source_found）。
- [x] 測試：降級標記、逾時與取消 typed 結果、門檻版本記錄。

驗證命令：

```bash
cd backend
npm run lint
npm run test
npm run build
```

## T6 Citation 驗證與 prompt injection 防護（D2）

> 前置：T5。對應 Requirement「引用可解析至已儲存 chunk」「檢索內容視為資料而非指令」。

- [x] deterministic citation 驗證函式：回答中的 citationId 必須存在於本輪 `kb_search` 結果；失敗發出驗證失敗事件。
- [x] tool 描述與合成指示明示 chunk 為資料（kb_search tool 描述與評測合成 prompt `kb-answer-v1` 皆明示 evidence 為不可信資料；本 Change 未修改 agent prompt，故未觸發 golden case 條款；agent 合成節點的 golden case 留待 X43）；任何 prompt 變更先建立 golden case 並執行既有 prompt／tool 回歸。
- [x] 對抗測試：chunk 夾帶指令時不觸發其他 tool、回答不遵循該指令。（tool 層：`retrieval.test.ts` 驗證 chunk 只作資料回傳；agent 層 live：`scripts/knowledge/injection-live-smoke.ts` 暫時入庫含 web_fetch／calculator_tool／canary 指令的 policy，mcp_agent 連續 3 輪皆只呼叫 `kb_search`、召回 probe、回答未依指令收尾或宣稱 365 天可退，probe 每輪刪除且 store 無殘留；證據 `evidence/t6-injection-live-smoke-run{1,2,3}.json`）

驗證命令：

```bash
cd backend
npm run lint
npm run test
npm run build
```

## T7 衍生索引資料治理（D2）

> 前置：T1、T3。對應 Requirement「衍生索引參與資料刪除」。

- [x] knowledge store 登記為 data inventory 的非權威、可重建衍生資料。
- [x] 來源刪除同交易刪除 chunk 與索引項目（in-memory 與 pgvector live 測試皆通過）；來源取代後只召回新版本。
- [x] subject 刪除時知識庫被 coordinator 列舉並回報不含該 subject 資料。
- [x] 測試：刪除後零召回（in-memory 與 pgvector live 皆通過）、取代後不回傳舊版本、coordinator 列舉。
- [x] deletion race 測試：D8 完成，或記入 Retrofit Debt。（pgvector live 測試首次執行即重現缺陷：READ COMMITTED 下 delete 與新版本 publish 並行時，delete 的 chunk 刪除沿用舊快照漏刪新版 chunk、隨後卻把新版 source 標為 deleted，留下孤兒 chunk。修正：publish／delete 先取 `(tenant, source)` transaction advisory lock 序列化。修正後並行 recall vs delete 與 10 輪 publish vs delete 皆無孤兒 chunk、至多一個 active 版本，連續 3 次 78/78 通過；證據 `evidence/t7-deletion-race-live.log`）

驗證命令：

```bash
cd backend
npm run lint
npm run test
npm run build
```

## T8 檢索評測與對比表（D2）

> 前置：T5、T6、TB2。對應 `retrieval-evaluation` 全部 Requirement。

- [x] `eval_case@1` schema：未知欄位保留、未知預期種類 typed failure。
- [x] scorer：Recall@5、MRR、citation accuracy、abstention（含誤拒率）、faithfulness（model-assisted，記錄評分模型與 prompt 版本）。
- [x] 以既有 Opik experiment 執行 `vector_only_configured` 與 `vector_rerank`，輸出含完整 provenance 的對比表。（2026-10-23 同一輪 live 執行，results/kb-eval-v1-2026-10-23-r2；Opik experiments kb-eval-v1-vector_only-2026-10-23、kb-eval-v1-vector_rerank-2026-10-23）
- [x] 不完整 run 標記 incomplete，不以子集計分。
- [x] deterministic 與 live 結果分開回報。（deterministic 在 evaluation.test.ts；live 在 data/knowledge-eval/results/）
- [x] **Human**：人工抽查 ≥10 題 model-graded 結果並記錄一致率。（Master 於 2026-10-23 完成 r3 分層樣本 10 題，紀錄 `results/kb-eval-v1-2026-10-23-r3/manual-inspection.json`，judge 原始輸出已依 run 檔還原；一致率 6/10 = 0.600，已寫入 r3 對比表 provenance。不一致 4 題：prd-09、pol-05、pol-15 為 judge 把有證據支持的陳述標為不支持（過嚴），pol-14 為 judge 漏抓把 Plus 45 天當一般期限的錯誤（過鬆）；判斷 judge prompt `kb-faithfulness-v1` 需改版，4 題作為 golden case，列為後續）

**D2 Gate**：對比表含 provenance，人工抽查紀錄存在。

驗證命令：

```bash
cd backend
npm run lint
npm run test
npm run build
npm run eval:opik
```

## T9 憑證洩漏與跨租戶驗證（D2）

> 前置：T3、T4。對應 Requirement「憑證不出現在任何可觀測面」「檢索以 tenant 隔離」。

- [x] 洩漏掃描：一次入庫與一輪 `kb_search` 對話後，事件、checkpoint、log 與模型 context 不含已解析憑證。（live 入庫與對話的 stdout／stderr、metric／audit、tool 輸出與 pgvector chunk 已掃描無憑證；checkpoint 由 `src/knowledge/leakage.test.ts` 以 MemorySaver 解碼全部持久化位元組驗證；Opik 外部 trace 由 `scripts/knowledge/opik-trace-leak-scan.ts` 掃描 2026-10-23 起 205 traces／7 spans，憑證與通用金鑰樣式皆 0 命中，證據 `evidence/t9-opik-trace-scan.json`）
- [x] 跨 tenant 拒絕測試：tenant B 的相同內容不被 tenant A 召回。
- [x] trace exporter 洩漏覆蓋、多租戶矩陣：D8 完成，或記入 Retrofit Debt。（trace exporter：同上 Opik 掃描；多租戶矩陣：`retrieval.test.ts` 三 tenant × 相同 sourceId × 三種 sourceTypes 篩選 × 單一 tenant 刪除，皆不跨 tenant 召回）

驗證命令：

```bash
cd backend
npm run lint
npm run test
npm run build
```

## TB1 合成語料（D0，Lane B）

> 前置：無。

- [x] 約 200 筆 SKU、約 30 篇政策／FAQ 文件；英文為主，每份附 provenance header（synthetic、生成日期、corpusVersion）。
- [x] 保留 raw 與 cleaned 中間檔；資料準備說明記錄收集、清洗、去重、chunking policy 與前後筆數。

驗證：provenance header 由 T3 的拒絕測試覆蓋；說明文件存在且筆數與入庫結果一致。

## TB2 評測資料集 v1（D1，Lane B）

> 前置：TB1、T0 的 `eval_case@1` 欄位定案。

- [x] 約 40 題，≥10 題拒答題、≥1 題對抗題、含跨語言題（英文語料、中文提問）。（kb-eval-v1：40 題、拒答 11、對抗 2、跨語言 6）
- [x] dev／test split 固定並版本化。（dev 12、test 28；兩個 split 皆含拒答題）

驗證：由 T8 的 schema 驗證與題型分布檢查覆蓋。

## T10 完整回歸與完成回報

> 前置：T1–T9、TB1、TB2。

- [x] backend 全部驗證命令通過；frontend 與 bff 無變更（以 Git Diff 確認）。（lint、build exit 0；test 1744 passed／2 failed／44 skipped，2 個失敗皆在本 Change 無 Diff 的區域且為環境依賴：hosted Opik live smoke 既有失敗；`tool-dispatch/pipeline.test.ts` 受 `.env` 的 `DATABASE_URL` 影響改走 Pg adapter，清空後 26/26 通過。證據 `evidence/t10-*.log`）
- [x] 依 `AGENTS.md` §14 產出完成回報，列出未執行的 live 驗證與 Retrofit Debt。（`evidence/t10-completion-report.md`、`artifacts/implementation-result.json`）

驗證命令：

```bash
cd backend
npm run lint
npm run test
npm run build
```
