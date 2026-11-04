# Proposal：修正 adapter 對布林值與純插值組合值的憑證誤判

## 問題

`demo-cost-and-access-guard` 的 review-result-review-result-001 由 Qwen 正常完成審查，但 adapter 的 Secret 掃描在原始 stdout 命中 3 行 `credential_assignment`，原始 stdout 被抑制、evidence gate 以 `raw_output_contains_secret` 失敗，審查結論無法保存。CCR 逐一查證，3 處都不是憑證：

1. 一份 evidence 的說明文字中，以 cookie 結尾的複合欄位名稱被指派布林值 false（同一檔案被讀取兩次，計 2 行）。
2. `bff/src/demo/visitor-session.ts` 組 Set-Cookie 回應標頭的樣板字串：值由多個變數插值與 `=`、`.` 等分隔符號組成，插值之外沒有任何字面英數字。

現行規則只排除「整個值只有一個變數插值」與「bare null」。布林值與「多個插值的組合」都不含憑證內容，卻被判為 Secret。任何審查只要讀到訪客 session cookie 的實作，就一定會失敗。

## 解決方案

1. 在 `qwen-readonly-result-capture` 規格新增 Requirement：未加引號的布林字面值，以及「只由變數插值與分隔符號組成、插值之外沒有字面英數字」的值，不視為 Secret。
2. 加引號的布林值、以布林開頭的較長值、插值之外帶有字面英數字的值，仍要命中。
3. 判定在 stream-json 的 JSON 轉義形式與未轉義形式下 MUST 一致。
4. Codex 修改掃描規則並補測試；Qwen 以 review-result 審查；CCR 不是撰寫者，執行 readiness-check。
5. 本 Change 的 Qwen review capture 另做雙版本掃描，確認舊規則多出的命中只屬於本次放寬的兩類，避免掃描器替自己背書。

## 受影響範圍

| 項目 | 影響 |
| --- | --- |
| 能力域 | `qwen-readonly-result-capture`（Secret 掃描行為） |
| 套件 | 無。frontend、bff、backend 均不受影響 |
| 工具 | `tools/qwen-capture-adapter.mjs` 的 `credential_assignment` 規則與 `tools/qwen-capture-adapter.test.mjs` |
| 下游 Change | `demo-cost-and-access-guard` 的 review-result 重跑等待本 Change 歸檔 |

## 目標

- 兩類誤判不再命中，且每個反例仍命中。
- 規格明確定義放寬範圍與已知限制，每個 Scenario 對應測試。
- 本 Change 的審查證據不只依賴被修改的掃描器。

## 非目標

- 不依檔名、路徑或欄位名稱白名單略過掃描（既有 Scenario「Secret 掃描不把程式碼當憑證」已禁止依檔名或路徑略過）。
- 不移除 `cookie` 等憑證詞，不修改其他 Secret 類別（provider key、cloud access key、private key、bearer token、JWT）。
- 不處理「以憑證詞結尾的常數被指派一般字串字面值」的情況（例如 cookie 名稱常數的未轉義形式）；這類值在語法上與真實憑證無法區分，維持命中（fail-closed），列為已知限制。
- 不修改 evidence gate、讀取稽核、CurrentState 轉換、hook 或 Master 授權檔。
- 不修正 review_result 的 `inputRefs` 格式問題；那是 review prompt 的問題，由 `demo-cost-and-access-guard` 重跑時處理。

## 風險

| 風險 | 緩解 |
| --- | --- |
| 放寬範圍過大，放過真實憑證 | 規格與測試同時要求反例仍命中；雙版本掃描確認舊規則多出的命中只屬於放寬的兩類 |
| 掃描器替自己的審查背書 | review capture 附雙版本掃描證據；不符合時視為 `INCOMPLETE` |
| 測試 fixture 本身形似憑證，Qwen 讀取後原始輸出被抑制 | fixture 以樣板字串拆開字面值；review prompt 以文字描述案例，不要求 Qwen 讀取測試檔 |

## 回滾策略

revert 本 Change 的 adapter 與測試修改即可回到現行規則；沒有資料遷移。回滾後 `demo-cost-and-access-guard` 的實作審查會再次因誤判失敗。
