# Tasks

驗證命令（皆於 `backend/` 執行）：

```bash
npm run lint
npm run test
npm run build
```

## 1. 前置確認

- [x] 1.1 確認工作樹中 `fix-knowledge-egress-in-container` 的未提交修改與本 Change 檔案邊界不重疊；若重疊，停止並回報 CCR，不得混入。驗證：在 implementation_result 列出 `git status --short` 與本 Change 修改清單。

## 2. Golden 資料集（先於 Prompt 定稿）

- [x] 2.1 新增並凍結 `order-request-golden-v1`（design D5）：回歸訊息、至少 12 則未看過的改寫、至少 3 則多筆訂單改寫（繁中、簡中、英文至少各一）、對照與聲稱預先核准案例，帶合成 provenance（Requirement「訂單請求行為 MUST 以獨立 Golden 資料集驗收」）。驗證：資料集 schema 單元測試。
- [x] 2.2 新增 live Golden 入口：只呼叫模型、綁定 Tool、不執行 Tool、不連 DB；輸出 design D5 與 Requirement 要求的欄位；憑證缺失標示未執行；任一呼叫失敗標示未完成。門檻以訊息為單位計算（design D5）。驗證：以 mock 模型測試通過、未通過、未完成與未執行四種結果，以及單則訊息 4/5 計為未通過、多筆訂單只發起一次呼叫計為未通過。

- [x] 2.3 依 design D8 新增並凍結 `order-request-golden-v2`，先於 Task 3.5 完成；v1 檔案不變（Requirement「訂單請求行為 MUST 以獨立 Golden 資料集驗收」）。驗證：雜湊鎖定與 schema 測試，測試讀取 v1 與 v2 檔案，逐一比對 v1 全部 caseId、訊息與預期一致，且這些案例在 v2 的 origin 都是 `regression`；另測新案例的 origin 都是 `unseen`，以及語系、數量與 `questionType` 下限。
- [x] 2.4 前置：Task 2.3 已凍結且雜湊已鎖定。live Golden 入口改用 v2，結果目錄不覆寫既有結果；報表註明舊版案例已不是未看過樣本。驗證：`order-request-golden` 測試。
- [x] 2.5 依 design D9 新增 `passed_with_known_limitation` 與 `--rescore`；報表逐則列出受影響訊息與次數，並註明規則是看到結果後修訂。驗證：`order-request-golden` 測試涵蓋只有狀態查詢、任一次變更呼叫、無效參數查詢、其餘門檻未達、未完成、原目錄不被修改與目標已存在；資料集雜湊或 prompt 版本與目前程式不一致時 MUST 拒絕重新計分。實際以 Golden v2 對 prompt v3 的結果執行，確認為 `passed_with_known_limitation`，且報表列出 `v2-feasibility-zh-cn` 與次數。

## 3. Prompt 與回覆

- [x] 3.1 依 design D2 更新 prompt，版本改為 `shopping-order-request-v2`，同步既有版本斷言（Requirement「已識別訂單的變更請求 MUST 發起 tool 呼叫進入審批」）。驗證：`order-branch` 單元測試。（此項是 v2 的歷史紀錄；D2 規則文字保留，版本字串與斷言由 Task 3.5 更新為 v3。）
- [x] 3.2 依 design D3 更新固定回覆，測試涵蓋未識別訂單與模型未發起呼叫，且不顯示模型文字。驗證：`order-branch` 單元測試。
- [x] 3.3 測試原因代碼不影響 business effect key，且 `other` 與 `damaged` 的請求依既有規則去重。驗證：`order-tools` 或 `order-branch` 測試。
- [x] 3.4 graph 測試：`other` 請求進入等待審批，審批前提交數為 0；使用者聲稱預先核准時同樣等待審批，且不記錄為審批；多筆訂單各自產生操作並等待審批。驗證：`graph` 或 `order-branch` 測試。
- [x] 3.5 依 design D7 附加規則，`SHOPPING_ORDER_REQUEST_PROMPT_VERSION` 改為 `shopping-order-request-v3`，同步 `order-branch` 與 `order-request-golden` 測試中所有版本字面值（Scenario「假設性問句不得變成變更」「詢問可行性不得變成變更」「以問句形式提出的請求仍是請求」）。驗證：`order-branch` 單元測試；模型行為由 Task 6.1 驗收，mock 測試不視為驗收。

## 4. 評測可診斷性

- [x] 4.1 observation 新增發起狀態、有界模型文字摘錄與截斷旗標；舊結果可讀取（design D4）。驗證：`chain-scoring` 測試。
- [x] 4.2 報表分開標示未發起呼叫與 terminal 錯誤，並標示閘門未執行；deterministic 標示為腳本決定。驗證：`chain-report` 測試。
- [x] 4.3 provenance 加入訂單請求 prompt 版本，deterministic 標示未使用。驗證：`chain-report` 與 `evaluate` 測試。

## 5. 回歸

- [x] 5.1 `commerce:evaluate --mode deterministic` 全部通過，結果不覆寫既有目錄。驗證：實際輸出摘要。
- [ ] 5.2 backend 全量 `npm run lint`、`npm run test`、`npm run build` 通過。驗證：實際輸出摘要。

## 6. Live 驗收（需要 Master 提供模型與隔離資料庫）

- [x] 6.1 以 qwen3.7-plus 對 prompt v3 執行 `order-request-golden-v2`，依 Requirement 門檻判定。未通過時依 design D8 停止並回報，不得調整門檻或新增 v4 prompt。驗證：Golden 結果檔。（2026-10-31 v1 對 prompt v2 未通過，v2 對 prompt v3 未通過，結果都保留。依 design D9 以 `--rescore` 重新計分 v2 結果，不重跑模型；結果須為 `passed_with_known_limitation` 才可繼續。）
- [ ] 6.2 Golden 通過且本 Change 的程式由 Master 提交後，從乾淨基準重跑 `commerce:evaluate --mode live`，以新日期目錄保存；不修改 `chain-eval-v1`，不得在未提交的工作樹上發布結果。驗證：`run.json`、`report.md`、`provenance.json`。
- [ ] 6.3 判定每個失敗案例的層級，並依 design D6 回報是否可解除 F-L1；新發現的問題如實列出，由 CCR 仲裁、Master 決定修復或接受；語意模糊訊息的 live 行為依 design D8 記為已知限制，不計入門檻。驗證：evidence 摘要。

## 7. 文件與交付

- [ ] 7.1 live 結果經 Master 接受後，更新 `docs/evaluation.md` 與 README 中受影響的數字與 F-L1 描述，並標明模型與日期。驗證：Diff 只含受影響內容，數字與 `run.json` 一致。
- [x] 7.2 implementation_result 列出修改檔案、Git Diff 摘要、已執行命令與結果、未驗證項目。
