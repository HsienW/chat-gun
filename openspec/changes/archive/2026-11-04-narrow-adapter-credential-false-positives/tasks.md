# Tasks

驗證命令（皆於 repo 根目錄執行）：

```bash
node --test tools/qwen-capture-adapter.test.mjs
openspec validate narrow-adapter-credential-false-positives --strict
```

## 0. 前置決定（Master）

- [x] 0.1 Master 決定是否在實作前另做 Qwen review-plan（design D4）。2026-11-02 Master 決定不做 review-plan，直接核准交 Codex 實作；獨立審查由 3.1 的 review-result 與 3.2 的雙版本掃描負責。驗證：決定記錄於 coordinator-result-plan-change-002。

## 1. 前置確認（Codex）

- [x] 1.1 確認 `tools/qwen-capture-adapter.mjs` 與 `tools/qwen-capture-adapter.test.mjs` 在工作樹中的未提交修改的來源與內容（design D2 第 5 點）；不屬於本 Change 的修改不得混入或覆蓋。驗證：implementation_result 列出 `git status --short -- tools/` 與 `git diff --stat -- tools/` 的輸出與判斷；無法判斷時停止並回報 CCR。

## 2. 實作（Codex）

- [x] 2.1 修改 `SECRET_PATTERNS.credential_assignment`，新增布林字面值與純插值組合兩種排除（Requirement「憑證欄位的布林值與純插值組合值不視為 Secret」；design D1、D2）。驗證：`git diff -- tools/qwen-capture-adapter.mjs` 只含該規則與註解。
- [x] 2.2 在掃描案例表補上 spec 每個 Scenario 的案例，含 JSON 轉義形式與觸發事件兩類誤判的結構重建案例；fixture 以樣板字串拆開字面值。驗證：`node --test tools/qwen-capture-adapter.test.mjs` 通過；既有案例未刪除或放寬。
- [x] 2.3 建立追溯表：spec 每個 Scenario 對應的測試名稱；「命中時沿用 fail-closed 行為」與「既有 Secret 掃描行為不回歸」指出既有測試，找不到時補上。驗證：追溯表列於 implementation_result，沒有未對應的 Scenario。
- [x] 2.4 產出 implementation_result（`producer: "Codex"`），列出修改檔案、Git Diff、已執行命令與結果、未驗證項目。驗證：通過 `agent-result.schema.json`。

## 3. 獨立審查（Qwen，經 adapter）

- [x] 3.1 經 adapter 啟動 review-result；review prompt 依 design D4 以文字描述案例，不要求 Qwen 讀取測試檔的掃描案例表。驗證：capture 的 evidence gate 結果與 review_result 已保存。
- [x] 3.2 依 design D3，由 Codex 對 review-result capture 執行雙版本掃描並保存證據。驗證：證據判定為 `passed`；`failed` 時該次審查視為 `INCOMPLETE`，回報 CCR。

## 4. 驗收與歸檔

- [x] 4.1 readiness-check（CCR，非 producer）：spec 每個 Scenario 有測試證據、雙版本掃描證據為 `passed`、沒有未解決的 Blocker／Major。驗證：readiness_result 的 producer 不是 Codex。證據：readiness-result-001（CCR，READY）。
- [x] 4.2 依 archive-change 階段契約歸檔，spec delta 合併進主規格；git commit 由 Master 執行。驗證：`openspec validate --strict` 通過，主規格含新的 Requirement。證據：archive-result-002，主規格 strict 與完整 delta 比對皆通過。
- [ ] 4.3 歸檔後，CCR 讓 `demo-cost-and-access-guard` 以新 artifactId 重跑 review-result，prompt 寫明 `inputRefs` 欄位格式（design D5）。驗證：CCR 的 coordinator_result 記錄重跑的 artifactId。
