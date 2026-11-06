# Tasks：1B-2 重跑前修正知識庫評測量測

**Implementer**：Codex。**未經 review-plan 通過與 Master 批准不得開始。**

**範圍限制**：MUST NOT 修改 `backend/src/evaluation/commerce/*`、`backend/package.json`、`backend/data/knowledge-eval/kb-eval-v1.json`、`backend/data/knowledge-eval/results/*`、`backend/scripts/knowledge/build-eval-dataset.ts`、`backend/src/knowledge/retrieval.ts`、`backend/src/knowledge/evaluation/scorers.ts`。`eval-case.ts` 只能新增匯出。

除特別註明，驗證目錄為 `backend/`。Task 勾選條件依 AGENTS.md 第 12 節。

## 1. 前置

- [x] 1.1 在獨立 worktree 從 `feat/4.6.5-feat/lane-knowledge-retrieval` 的最新提交建立工作分支（不得基於 `aaba3a3`，不得在 F-L1 的未提交工作樹內施工）。驗證：implementation_result 記錄 base commit，且 `git merge-base --is-ancestor 740cc4e HEAD` 成功。
- [x] 1.2 確認基準未被 F-L1 改動下列受限檔案以外的評測合約。驗證：`git diff --stat 740cc4e HEAD -- src/knowledge/evaluation` 結果記入 implementation_result；若有差異先回報 CCR。

## 2. 階段延遲（Requirement：逐階段量測、Rerank 延遲只由階段量測發布）

- [x] 2.1 新增階段記錄器與 gateway、store、synthesizer、judge 裝飾器，`CaseResult` 新增可選 `stageLatency`；`latencyMs` 語意不變。測試用假時鐘涵蓋：全部完成、vector_only 未執行 rerank、未產生回答、rerank 失敗降級、各階段失敗與逾時、取消、總和不超過 `latencyMs`。驗證：`npx vitest run src/knowledge/evaluation`。
- [x] 2.2 `summarize` 新增階段彙總與檢索總延遲；P50／P95 只用已完成的量測，rerank 失敗次數另列且計入檢索總延遲；缺欄位的舊結果為未量測。驗證：同上，並測試讀取 `kb-eval-v1-2026-10-27-r2/run-vector_rerank.json` 不失敗且顯示未量測。
- [x] 2.3 報表新增階段延遲表，總延遲欄標示含生成與 Judge；未執行不得顯示 0；未完成執行不可發布。驗證：同上。
- [x] 2.4 `caseScores` 帶入 `stageLatency`。驗證：同上。

## 3. v2 資料集契約與驗證（Requirement：獨立版本、組成與 ground truth、來源不跨分割）

- [x] 3.1 新增來源類別讀取（未知與缺值為未分類）與必要標籤常數。驗證：測試含 v1 案例讀為未分類；`eval_case@1` 既有測試不變；`chain-case` 測試仍通過：`npx vitest run src/knowledge/evaluation src/evaluation/commerce/chain-dataset.test.ts`。
- [x] 3.2 新增不呼叫模型的組成驗證器，回傳問題代碼：題數與下限、六個必要標籤各項條件、ground truth（key fact、SKU、same_series 可分辨性、multi_answer 規則重算、虛構 SKU、跨語言、跨來源、相同標題）。每項規則都有對應的失敗測試。驗證：`npx vitest run src/knowledge/evaluation`。
- [x] 3.3 驗證器新增 union-find 跨分割檢查、v1 dev 來源隔離（由 v1 檔案推導）與 v1 題目重複檢查。測試涵蓋直接跨分割、經同系列遞移、v1 dev 來源出現在 test。驗證：同上。

## 4. v2 資料集（Requirement：組成；未經 Master 審閱不得凍結）

- [x] 4.1 新增 v2 建構腳本：先分區語料，再以固定種子產生約 60 題模板題；兩次執行輸出相同。驗證：`npx tsx scripts/knowledge/build-eval-dataset-v2.ts` 跑兩次後比對無差異；不呼叫模型。v1 檔案 `git diff` 為空。
- [x] 4.2 起草約 30 題人工題，記錄 `authoredBy`，不得執行任何檢索。下限在語料上無法達成時停止回報 CCR，不得自行降低。驗證：組成驗證無問題；implementation_result 聲明起草期間未執行檢索或模型。
- [x] 4.3 **Gate（Master）**：提供人工題清單（題目、相關來源、key fact、標籤）供 Master 審閱，等待明確確認。依回覆修改後重跑 4.2 驗證。驗證：implementation_result 引用該次確認。

## 5. 凍結（Requirement：實作混合檢索前凍結）

- [x] 5.1 實作正規化雜湊與凍結驗證，含錯誤碼 `EVAL_DATASET_NOT_FROZEN`、`EVAL_DATASET_HASH_MISMATCH`。測試涵蓋：一致、改動一題、缺紀錄、缺 `review`、CRLF 差異不算改動。驗證：`npx vitest run src/knowledge/evaluation`。
- [x] 5.2 Task 4.3 完成後才寫入凍結紀錄。測試固定 v2 雜湊與 v1 雜湊。驗證：同上。4.3 未完成時本項與 5.3 保持未勾選，並如實回報。
- [x] 5.3 確認凍結前無 v2 live 結果。驗證：`backend/data/knowledge-eval/results/` 無 `kb-eval-v2-*`。

## 6. CLI（Requirement：獨立版本、凍結）

- [x] 6.1 `evaluate.cli.ts` 支援 `--dataset`，預設 v1；不合法名稱、路徑穿越、缺檔、未凍結、雜湊不符都在建立模型物件前失敗；provenance 新增 `datasetSha256`、`queryMode`。把驗證抽成可測函式，測試斷言失敗路徑不呼叫模型。驗證：`npx vitest run src/knowledge/evaluation`。

## 7. 分層報表（Requirement：分層、模板題不得當整體提升、揭露 Query 差異）

- [x] 7.1 `CaseResult` 帶 `tags`、`origin`；`EvaluationRun` 新增 `strata`；分層的降級次數只計該分層，並修正 `row()` 的計數範圍。測試：重疊標籤、未分類、無樣本顯示不適用。驗證：同上。
- [x] 7.2 報表依 design D8 的順序輸出，混合總分標示不可作為提升依據，模板分層標示診斷用途。驗證：同上；v1 的既有指標斷言不變。
- [x] 7.3 實作提升判定。測試：只有模板題提升、人工題提升、n<5、差異小於解析度、雜湊不同、未完成執行。驗證：同上。
- [x] 7.4 報表與 provenance 揭露查詢模式與聲明，含 `cross_lingual` 說明。驗證：同上。

## 8. 回歸與交付

- [x] 8.1 `npm run lint`、`npm run test`、`npm run build`，失敗項如實記錄。
- [x] 8.2 `git diff --stat` 確認範圍限制內的檔案沒有變更；`git status --short -- data/knowledge-eval/results` 為空。
- [x] 8.3 `openspec validate harden-kb-evaluation-baseline --strict`。
- [x] 8.4 依 03-apply-change 契約輸出 implementation_result 與 evidence。`notExecuted` MUST 列出 live 評測與 Opik 上傳。

## 9. F-L1 提交後（選做）

- [ ] 9.1 只有 F-L1 已提交且 `backend/package.json` 乾淨時才可進行：新增 `knowledge:eval-dataset-v2`，指向 v2 建構腳本。未做不影響本 Change 完成。驗證：`npm run knowledge:eval-dataset-v2` 輸出與 Task 4.1 相同，`git diff` 確認 `kb-eval-v2.json` 無變更。
