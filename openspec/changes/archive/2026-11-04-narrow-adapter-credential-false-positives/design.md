# Design：修正 adapter 對布林值與純插值組合值的憑證誤判

## 背景與責任邊界

- 觸發事件：`demo-cost-and-access-guard` 的 review-result-review-result-001 capture。exit 0、已派出 reviewer subagent、`readScopeFindings` 為空，但 `secretHits.stdout` 有 3 行 `credential_assignment`，原始 stdout 被抑制，evidence gate reasons 為 `raw_output_contains_secret` 與 `review_result_schema_or_artifactId_invalid`。後者是 Qwen 輸出的 `inputRefs` 缺 `relativePath`，屬於 review prompt 問題，不在本 Change 範圍。
- CCR 依 capture 的 `toolUseIds` 對回讀取目標並查證（不保存原文）：
  - evidence 說明文字：以 cookie 結尾的複合欄位名稱接等號與 false（2 行，同一檔案讀兩次）。
  - `bff/src/demo/visitor-session.ts`：Set-Cookie 樣板的值由三段插值（cookie 名稱常數、payload、簽章函式呼叫）與等號、句點組成。
- 本 Change 只影響本機 Agent 工作流程中的 Qwen review capture 工具。frontend、bff、backend 無變更；`visitor-session.ts` 不為迴避掃描而修改。
- Primary Implementer：Codex。CCR 只撰寫本 Change 的規劃文件，不修改 adapter，因此 CCR 可以執行 readiness-check（非 implementation_result 的 producer）。

## D1：規則語意

現行 `credential_assignment` 的值位置有兩個排除：整個值只有一個變數插值（可含 scheme 字樣），以及 bare null。本 Change 新增兩個同性質的排除，都只看值本身：

1. **布林字面值**：未加引號的 true／false，不分大小寫，之後的字元必須是行尾、空白、引號、逗號、分號、右大括號、右括號或右中括號。比 bare null 規則多允許右括號與右中括號，因為布林值常出現在函式引數與陣列中；bare null 的既有行為不變。
2. **純插值組合**：值由一段或多段 `${...}` 插值組成，插值之間與前後只允許固定的分隔符號（見 spec），並可被一對引號或反引號包住。插值內容限於識別字、成員存取與以識別字為引數的函式呼叫；插值內出現引號字面值即不屬於此排除。

兩者都不含憑證的字面內容。判定為 Secret 的條件仍是「值中存在字面內容」，方向與既有規則一致。

### JSON 轉義形式

adapter 逐行掃描 stream-json 原始 stdout；工具結果中的檔案內容以 JSON 字串轉義。兩個排除在轉義形式下必須同樣成立（例如插值前後的反引號不會被轉義，引號會變成 `\"`）。本 Change 不改變既有規則對轉義形式中其他值的判定：既有規則對轉義後的引號字面值較寬鬆，收緊會讓更多程式碼被誤判，不在本 Change 處理。

### 已知限制（維持 fail-closed）

- 以憑證詞結尾的常數被指派一般字串字面值（例如 cookie 名稱常數的未轉義形式）仍命中。這類值在語法上與真實憑證無法區分。
- 其他語言的空值與布林字面（None、True、nil 等非 true／false 拼法）長度達 4 字元時仍命中。
- 欄位名稱沒有字詞邊界，以憑證詞結尾的複合名稱仍視為憑證欄位。

### 替代方案

| 方案 | 結論 |
| --- | --- |
| 依檔名或路徑略過掃描（例如 `bff/src/**`） | 否決。既有 Scenario「Secret 掃描不把程式碼當憑證」明定 MUST NOT 依檔名或路徑略過 |
| 從憑證詞清單移除 cookie | 否決。Cookie 標頭值確實可能是 session 憑證 |
| 以行內容雜湊建立人工豁免清單 | 否決。需要新的授權來源與維護流程，且屬於硬映射 |
| 修改 `visitor-session.ts` 或 evidence 文字迴避掃描 | 否決。把工具缺陷轉嫁給產品程式碼與證據 |
| 先解析程式語法再判定 | 否決。改動面遠大於本次誤判 |

## D2：實作方式

1. 只修改 `tools/qwen-capture-adapter.mjs` 的 `SECRET_PATTERNS.credential_assignment`（可拆為具名的值排除片段），並更新其註解。不修改其他類別、掃描函式介面、evidence gate 或讀取稽核。
2. 在 `tools/qwen-capture-adapter.test.mjs` 既有的掃描案例表補上 spec 每個 Scenario 的案例，包含 JSON 轉義形式（以 `JSON.stringify` 包成 stream-json 工具結果事件後再掃描）。fixture 延續既有寫法，以樣板字串拆開字面值，讓測試原始碼本身不形成完整的憑證樣式。
3. 以觸發事件的兩類誤判建立回歸案例，內容以結構重建，不複製產品原始碼或 evidence 原文。
4. 既有掃描案例 MUST 全數維持原判定；不得刪除或放寬既有 Assertion。
5. 工作樹中 `tools/qwen-capture-adapter.test.mjs` 已有未提交修改。Codex 開始前 MUST 確認這些修改的來源與內容，在 implementation_result 說明；不屬於本 Change 的修改不得混入或覆蓋，無法判斷時停止並回報 CCR。

## D3：雙版本掃描證據（避免掃描器替自己背書）

沿用 `adopt-adapter-null-credential-rule` 的做法：本 Change 的 review-result capture 由 Codex 另外以兩版規則掃描並保存證據。

- 舊版：HEAD 的 `SECRET_PATTERNS` 物件字面值（`git show HEAD:tools/qwen-capture-adapter.mjs`）；新版：工作樹的字面值。只擷取物件字面值，於 repo 外的暫存腳本求值，不 import 舊版 adapter。
- 忠實度檢查：兩版 key 集合相同，只有 `credential_assignment` 不同；以兩版掃描本 Change 新增的案例，放寬類案例在舊版命中、新版不命中，其他案例兩版相同且與測試預期一致。
- 掃描對象：已保存的原始 stdout、stderr（若有）與 review_result 序列化字串。原始輸出若被抑制，代表新版已命中，該次審查本來就是 `INCOMPLETE`。
- 判定：新版命中數為 0；舊版多出的每一行命中，類別只能是 `credential_assignment`，且每個匹配值都屬於 D1 的兩種排除。不符即 `failed`，該次審查視為 `INCOMPLETE`。
- 證據保存為 `.agent-runtime/narrow-adapter-credential-false-positives/artifacts/dual-scan-<capture artifactId>.json`，只記錄 SHA-256、行號、事件類型、欄位名稱與值類別（`boolean`、`interpolation_composite` 或 `other`），不得保存值內容或整行原文。

## D4：審查與驗收

- Qwen 以 review-result 審查實作。review prompt 以文字描述案例，提醒 Qwen 不要讀取測試檔的掃描案例表；測試結果由 Codex 的 implementation_result 與雙版本掃描證據提供。Qwen 若判斷無法在此限制下可靠審查，應輸出 `INCOMPLETE` 並說明。
- 是否另做 review-plan 由 Master 決定（見 tasks 0.1）。Master 於 2026-11-02 決定不做 review-plan，直接核准交 Codex；理由是改動只有一條掃描規則與測試，規格沿用已歸檔的 bare null 前例，且實作後仍有 review-result 與雙版本掃描。
- readiness-check 由 CCR 執行；CCR 不是 implementation_result 的 producer，不需要 `self_acceptance` 授權。

## D5：歸檔與下游

- 歸檔依 archive-change 階段契約執行，spec delta 合併進 `openspec/specs/qwen-readonly-result-capture/spec.md`；git commit 由 Master 執行。
- 歸檔後，CCR 讓 `demo-cost-and-access-guard` 以新的 artifactId 重跑 review-result，新 prompt 同時寫明 review_result `inputRefs` 每筆必須含 `artifactId`、`changeId`、`kind`、`relativePath`。本 Change 不讀取、不寫入該 Change 的 Runtime。

## 安全與權限分析

- 本規則只放寬兩種沒有字面內容的值，其他類別與帶字面內容的值判定不變；放寬方向的風險由 spec 反例 Scenario、D2 的回歸案例與 D3 的雙版本掃描控制。
- 不新增 Qwen 的工具或權限，不修改讀取稽核、evidence gate、CurrentState 轉換、hook 或 Master 授權檔。

## 驗證計畫

| 項目 | 方式 |
| --- | --- |
| 規格結構 | `openspec validate narrow-adapter-credential-false-positives --strict` |
| 掃描行為 | `node --test tools/qwen-capture-adapter.test.mjs` |
| 實作範圍 | `git diff -- tools/qwen-capture-adapter.mjs` 只含 `credential_assignment` 與註解 |
| 審查獨立性 | review-result capture 的雙版本掃描證據為 `passed` |
| 驗收 Gate | readiness_result 的 producer 不是 implementation_result 的 producer |

## 風險

| 風險 | 影響 | 緩解 |
| --- | --- | --- |
| 純插值組合的分隔符號集合過寬 | 放過以插值拼接的真實憑證 | 分隔符號為封閉集合且不含英數字；反例 Scenario 守住夾帶字面值 |
| 工作樹既有的測試檔修改被覆蓋 | 他人工作遺失 | D2 第 5 點：開始前確認並回報 |
| Qwen 讀到 fixture 導致 capture 失敗 | 審查 `INCOMPLETE`，需重跑 | D4 prompt 限制 |
