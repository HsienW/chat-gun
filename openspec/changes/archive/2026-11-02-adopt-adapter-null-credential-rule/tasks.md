# Tasks

驗證命令（皆於 repo 根目錄執行）：

```bash
node --test tools/qwen-capture-adapter.test.mjs
openspec validate adopt-adapter-null-credential-rule --strict
```

既有待審實作：commit `934b2d5`。Codex 只做採納與驗證，不重寫掃描器、不補寫歷史授權（design D2）。

## 1. 前置確認（Codex）

- [x] 1.1 確認 `934b2d5` 是 HEAD 的祖先、`934b2d5^..HEAD` 只有 `934b2d5` 修改 adapter 與其測試，且工作樹中這兩個檔案沒有未提交修改；工作樹中其他 agent 的未追蹤檔案不得碰觸或混入。驗證：在 implementation_result 列出 `git merge-base --is-ancestor 934b2d5 HEAD`、`git log --oneline 934b2d5^..HEAD -- tools/qwen-capture-adapter.mjs tools/qwen-capture-adapter.test.mjs`、`git diff 934b2d5 -- tools/qwen-capture-adapter.mjs` 與 `git status --short` 的輸出。
- [x] 1.2 依 design D3，對本 Change 的 review-plan capture 執行雙版本掃描並保存 `dual-scan-<capture artifactId>.json`（Requirement「憑證欄位的 bare null 值不視為 Secret」）。驗證：證據檔判定為 `passed`；`failed` 時停止並回報 CCR，不進入第 2 節。

## 2. 採納驗證（Codex）

- [x] 2.1 建立追溯表：spec delta 每個 Scenario 對應的測試名稱；`934b2d5` 的 6 個案例逐一對應到 Scenario（Requirement「憑證欄位的 bare null 值不視為 Secret」）。驗證：追溯表列於 implementation_result，沒有未對應的 Scenario。
- [x] 2.2 依 design D2，在既有掃描案例表補上「同一行的 bare null 不遮蔽其他憑證」與「大寫的 bare null」兩個案例，fixture 以樣板字串拆開字面值；不得修改 `SECRET_PATTERNS` 或掃描函式。驗證：`node --test tools/qwen-capture-adapter.test.mjs` 通過；若新案例失敗，停止並回報 CCR，不得修改掃描器。
- [x] 2.3 確認 Scenario「命中時沿用 fail-closed 行為」與「既有 Secret 掃描行為不回歸」已有測試覆蓋；找不到對應測試時補上。驗證：追溯表列出測試名稱；`node --test tools/qwen-capture-adapter.test.mjs` 通過。
- [x] 2.4 產出 implementation_result（`producer: "Codex"`）：寫明掃描器程式碼來自 `934b2d5`、撰寫者為 CCR、當時沒有 Master 授權；列出 Codex 實際修改的檔案、Git Diff、已執行命令與結果、未驗證項目。驗證：implementation_result 通過 `agent-result.schema.json`，diff 只含 2.2／2.3 的測試新增。

## 3. 獨立審查（Qwen，經 adapter）

- [x] 3.1 CLIHost 經 adapter 啟動 review-result；review prompt 依 design D5 以文字描述案例，不要求 Qwen 讀取該測試檔，並附上 Codex 的測試輸出摘要。驗證：capture 的 evidence gate 結果與 review_result 已保存。
- [x] 3.2 依 design D3，由 Codex 對 review-result capture 執行雙版本掃描並保存證據。驗證：證據檔判定為 `passed`；`failed` 時該次審查視為 `INCOMPLETE`，回報 CCR，由 Master 決定。

## 4. 驗收與歸檔

- [x] 4.1 前置：Master 依 design D4 擇一，為 Codex 新增涵蓋本 Change readiness handoff 的 `self_acceptance` 授權，或由 Master 本人驗收。CCR 不得驗收。驗證：readiness handoff 的 `authorizationRef` 指向該授權，或 readiness_result 由 Master 產出。
- [x] 4.2 readiness-check：確認 spec 每個 Scenario 有測試證據、兩份雙版本掃描證據皆為 `passed`、沒有未解決的 Blocker／Major。驗證：readiness_result 的 producer 不是 CCR；若為 Codex，inputRefs 帶 authorizationId 與 authorizationSnapshot。
- [x] 4.3 依 archive-change 階段契約歸檔，spec delta 合併進主規格；git commit 由 Master 執行。驗證：`openspec validate --strict` 通過，主規格含新的 Requirement。
- [ ] 4.4 歸檔後，CCR 通知 `fix-order-request-tool-initiation` 的協調工作階段：本 Change 已歸檔，可重跑 review-result-04。驗證：本 Change 的 archive_result 或 CCR coordinator_result 記錄通知內容與時間。
