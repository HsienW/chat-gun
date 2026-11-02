# Design：補審並採納 adapter 的 bare null 憑證欄位規則

## 背景與責任邊界

- 待審實作：commit `934b2d5`（`fix(qwen-adapter): treat a bare null credential field as no secret`），只修改 `tools/qwen-capture-adapter.mjs` 中 `SECRET_PATTERNS.credential_assignment` 的一行與註解，並在 `tools/qwen-capture-adapter.test.mjs` 的掃描案例表新增 6 個案例。`934b2d5` 是目前 HEAD 的祖先；`934b2d5^..HEAD` 之間沒有其他 commit 修改這兩個檔案。
- 撰寫者：CCR，當時沒有涵蓋該任務的有效 Master 授權（F-L1 R2 Blocker）。本 Change 不補寫該授權，也不把它視為合法的 implementation_secondary 產出；它只是「一份需要補審的既有程式碼」。
- frontend、bff、backend：無變更。本 Change 只影響本機 Agent 工作流程中的 Qwen review capture 工具。

## D1：規則語意

`934b2d5` 在值的位置加上排除條件：值以 `null` 開頭，且 `null` 之後的下一個字元不是「非空白、非引號、非逗號、非分號、非右大括號」的字元時，不視為憑證。換句話說，`null` 之後必須是行尾、空白、單或雙引號、逗號、分號或右大括號。整個 pattern 帶 `i` 旗標，所以 `NULL`、`Null` 也適用，與欄位名稱比對一致。

規格採用同樣的語意（見 spec delta）。以下維持既有行為，不在本 Change 處理，列為已知限制：

- `null` 之後接右括號或右中括號時仍會命中（誤判保留，fail-closed 方向）。
- 其他語言的空值字面（None、undefined 等）長度達 4 字元時仍會命中。
- 欄位名稱的比對沒有字詞邊界，所以以憑證詞結尾的複合名稱也會被當成憑證欄位；這是既有行為，`934b2d5` 新增的「複合名稱中的真實憑證」案例正是保護這一點。

### 替代方案

| 方案 | 結論 |
| --- | --- |
| revert `934b2d5`，要求 Qwen 不輸出 null 授權欄位 | 否決。bare null 確實不含憑證，這是掃描器誤判；以 Prompt 迴避會把工具缺陷轉嫁給模型，且 Master 已決定保留 |
| 以欄位名稱白名單（例如特定的 pending 授權欄位）豁免 | 否決。屬於硬映射，違反 AGENTS.md §6 |
| 先解析 JSON 結構，再略過值為 null 的欄位 | 否決。stdout 是逐行 stream-json 且可能含非 JSON 文字，改動面遠大於本次誤判，另需設計 |

## D2：採納方式（Codex 不重寫）

Codex 是本 Change 的 Primary Implementer，但工作是採納與驗證：

1. 不修改 `SECRET_PATTERNS` 或掃描函式。若 Codex 認為 `934b2d5` 有缺陷，只能在 implementation_result 回報，交由 CCR 仲裁、Master 決定，不得自行修正。
2. 可以在既有掃描案例表補上測試，只用於覆蓋 spec 中 `934b2d5` 沒有直接覆蓋的 Scenario：「同一行的 bare null 不遮蔽其他憑證」與「大寫的 bare null」。若補上的測試失敗，代表 `934b2d5` 與規格不符，Codex 停止並回報，不得修改掃描器讓測試通過。
3. 「命中時沿用 fail-closed 行為」與「既有 Secret 掃描行為不回歸」由既有測試覆蓋；Codex 要在追溯表指出對應的測試名稱，找不到時補測試。
4. 新增的測試 fixture 必須延續既有寫法：以樣板字串拆開字面值，讓測試原始碼本身不形成完整的憑證樣式。
5. implementation_result 的 `producer` 是 Codex，內容必須寫明掃描器程式碼來自 `934b2d5`、撰寫者為 CCR、當時沒有 Master 授權，以及 Codex 實際新增的檔案與 diff。

## D3：雙版本掃描證據（避免掃描器替自己背書）

本 Change 的每一次 Qwen review capture（review-plan 與 review-result）都由 Codex 另外執行雙版本掃描，並保存證據。adapter 的 evidence gate 不變；雙版本掃描是本 Change 的驗收證據，不是新的 adapter 行為。

### 取得兩版規則

- 以 `git show 934b2d5^:tools/qwen-capture-adapter.mjs` 與 `git show 934b2d5:tools/qwen-capture-adapter.mjs` 取得兩版原始碼，只擷取 `SECRET_PATTERNS = Object.freeze({ ... });` 的物件字面值。不要直接 import 舊版 adapter：它在載入時會讀取 backend 套件與 OpenSpec schema，與舊 commit 的環境不一致。
- 擷取後的字面值只含 regex，於 repo 外的暫存腳本中求值。腳本不提交、不放進 repo。
- 忠實度檢查：
  - `934b2d5` 版的字面值原始碼必須與工作樹 adapter 的字面值逐字相同。
  - 兩版字面值的 key 集合相同，且只有 `credential_assignment` 的 regex 不同。
  - 以兩版規則掃描 `934b2d5` 新增的 6 個案例與 D2 補上的案例：bare null 案例在舊版命中 `credential_assignment`、在新版沒有命中；其他案例兩版結果相同，且與測試預期一致。

### 掃描對象

與 adapter 判定 Secret 的位置一致，逐行掃描：

- 已保存的原始 stdout（CurrentState `latestArtifactRefs.reviewRawStdout`）。
- 已保存的原始 stderr（若有保存）。
- 已保存的 review_result 以 `JSON.stringify` 序列化後的字串。

原始 stdout 或 stderr 若被 adapter 抑制而沒有保存，代表新版規則已經命中、evidence gate 已失敗，該次審查本來就是 `INCOMPLETE`，不需要雙版本掃描。

### 判定標準

- 新版規則在所有掃描對象上的命中數必須為 0。
- 舊版規則多出的每一行命中：該行舊版命中的類別只能是 `credential_assignment`，且該行每一個舊版 `credential_assignment` 匹配的值都必須是 bare null（定義同 D1）。
- 任一條件不符時，雙版本掃描判定失敗：該次審查的 effective verdict 視為 `INCOMPLETE`，Codex 回報 CCR，由 Master 決定下一步。

### 證據內容

Codex 保存 `.agent-runtime/adopt-adapter-null-credential-rule/artifacts/dual-scan-<capture artifactId>.json`，內容至少包含：

- 兩個 commit SHA、兩版字面值原始碼的 SHA-256、暫存腳本全文或其 SHA-256。
- 忠實度檢查結果。
- 每個掃描對象的檔案 relativePath、SHA-256、行數、兩版命中總數。
- 舊版多出的每一行命中：掃描對象、行號、stream-json 事件類型（若可解析）、命中的欄位名稱、值類別（`bare_null` 或 `other`）。不得保存值內容或整行原文。
- 判定結果（`passed` 或 `failed`）與理由。

## D4：撰寫者驗收 Gate

依 `agent-role-policy` 的「撰寫者不得自行驗收」：

- `934b2d5` 的撰寫者是 CCR，CCR MUST NOT 執行本 Change 的 readiness-check 或最終驗收，也不得仲裁自己是衝突一方的 Finding。
- 採納結果的 implementation_result `producer` 是 Codex，Codex 執行 readiness-check 需要涵蓋當次任務的 Master `self_acceptance` 授權，readiness_result 的 inputRefs 必須帶 authorizationId 與 authorizationSnapshot。
- 因此 readiness-check 前，Master 必須擇一：
  - **方案 A（建議，符合本 Change 的驗收安排）**：Master 為本 Change 的 readiness handoff 新增授權給 Codex，`grants` 含 `self_acceptance`。這是事前、只涵蓋本次 readiness 的新授權，不是 `934b2d5` 的歷史授權。
  - **方案 B**：Master 本人執行 readiness-check。
- 這個決定只阻擋 readiness-check，不阻擋 review-plan、apply-change 或 review-result。

## D5：Qwen 審查與 fixture 讀取

- 掃描案例表中的 fixture 刻意做成憑證樣式。Qwen 以 read_file 或 grep_search 讀到那些行時，stream-json 的工具結果會讓原始 stdout 命中、evidence gate 失敗。review prompt 因此以文字描述案例，並提醒 Qwen 不要讀取該測試檔；測試結果由 Codex 的 implementation_result 與雙版本掃描證據提供。
- 本 Change 的 OpenSpec artifacts 也以文字描述案例，不寫出完整的「憑證欄位 + 指派 + 值」字串。
- Qwen 仍可讀取 adapter 中 `SECRET_PATTERNS` 的定義範圍與 `934b2d5` 的 diff 描述。若 Qwen 判斷無法在這個限制下可靠審查，應輸出 `INCOMPLETE` 並說明原因。

## D6：歸檔與下游通知

- 歸檔依 archive-change 階段契約執行，spec delta 合併進 `openspec/specs/qwen-readonly-result-capture/spec.md`。git commit 由 Master 執行。
- 歸檔後，CCR 通知 `fix-order-request-tool-initiation` 的協調工作階段：本 Change 已歸檔，可重跑 review-result-04。本 Change 不讀取、不寫入 F-L1 的 Runtime。

## 安全與權限分析

- Secret 掃描是 review capture 的安全控制。本規則只放寬一種沒有憑證內容的值，其他類別與實際字面值的判定不變；放寬方向的風險由 spec 的反例 Scenario、D2 的補充測試與 D3 的雙版本掃描控制。
- 本 Change 不新增 Qwen 的工具或權限，不修改讀取稽核、evidence gate、CurrentState 轉換、hook 或 Master 授權檔。
- 雙版本掃描腳本只讀 git 物件與已保存的 capture 檔案，不呼叫網路，不寫入 repo。

## 驗證計畫

| 項目 | 方式 |
| --- | --- |
| 規格結構 | `openspec validate adopt-adapter-null-credential-rule --strict` |
| 掃描行為 | `node --test tools/qwen-capture-adapter.test.mjs`，含 `934b2d5` 的 6 個案例與 D2 補充案例 |
| 實作範圍 | `git log --oneline 934b2d5^..HEAD -- tools/qwen-capture-adapter.mjs tools/qwen-capture-adapter.test.mjs`、`git diff 934b2d5 -- tools/qwen-capture-adapter.mjs`（應為空） |
| 審查獨立性 | review-plan 與 review-result 兩次 capture 的雙版本掃描證據皆為 `passed` |
| 驗收 Gate | readiness_result 的 producer 不是 CCR；若為 Codex，inputRefs 帶 self_acceptance 授權快照 |

## 風險

| 風險 | 影響 | 緩解 |
| --- | --- | --- |
| 雙版本掃描腳本擷取錯誤 | 證據失真 | D3 忠實度檢查；腳本全文或 SHA-256 入證據 |
| Qwen 讀到 fixture 導致 capture 失敗 | review `INCOMPLETE`，需重跑 | D5 prompt 限制；失敗時依 evidence gate 正常流程重跑，不得繞過 adapter |
| Master 未及時決定 D4 | readiness-check 卡住，F-L1 無法重跑 review-result-04 | 在 review-plan 階段就把 D4 列為待決事項 |
| 已知限制被誤當成本 Change 範圍 | 範圍膨脹 | D1 明列已知限制，另開 Change 處理 |
