# Proposal：補審並採納 adapter 的 bare null 憑證欄位規則

## 問題

Qwen capture adapter 的 Secret 掃描器，原本把「憑證欄位名稱後接 bare null」判為 `credential_assignment`。Qwen 在 review_result 中寫出值為 null 的授權相關欄位時，原始 stdout 會被抑制，evidence gate 以 `raw_output_contains_secret` 失敗，review 的 effective verdict 變成 `INCOMPLETE`。這是誤判：bare null 不含任何憑證內容。

commit `934b2d5` 修正了這個誤判：在 `credential_assignment` 的值位置加上排除條件，並新增 6 個測試案例。這個修改由 CCR 在沒有涵蓋該任務的有效 Master 授權時完成，沒有經過 OpenSpec、獨立審查與驗收。`fix-order-request-tool-initiation`（F-L1）的 Codex 驗收因此判定 NOT_READY（R2 Blocker）：F-L1 的 review-result-03 在舊掃描器下會命中，該次審查能通過，依賴的正是這個未經審查的修改。

Master 已決定保留 `934b2d5`，另開本 Change 補審。仲裁紀錄在 F-L1 的 coordinator-result-11（本 Change 不讀取該 Change 的 Runtime，只引用其結論）。

## 解決方案

1. 把 `934b2d5` 的行為寫進 `qwen-readonly-result-capture` 規格：bare null 值不視為 Secret；加引號的 null、以 null 開頭的較長值，以及複合欄位名稱中的真實憑證仍要命中。
2. 把 `934b2d5` 當成既有待審實作：Codex 只做採納與驗證，不重寫掃描器、不補寫歷史授權。
3. 防止掃描器替自己背書：本 Change 的 Qwen review capture，除了 adapter 本身的掃描，還要以 `934b2d5^` 與 `934b2d5` 兩版規則各掃一次並記錄；舊規則多出的命中只能是 bare null。
4. 驗收由 Codex 執行。歸檔後通知 F-L1，F-L1 的 review-result-04 才能重跑。

## 受影響範圍

| 項目 | 影響 |
| --- | --- |
| 能力域 | `qwen-readonly-result-capture`（Secret 掃描行為） |
| 套件 | 無。frontend、bff、backend 均不受影響 |
| 工具 | Qwen capture adapter 與其測試；本 Change 預期不再修改，只驗證 `934b2d5` |
| 下游 Change | `fix-order-request-tool-initiation` 的 review-result-04 等待本 Change 歸檔 |

## 目標

- 規格明確定義 bare null 的排除範圍與仍須命中的反例，每個 Scenario 對應既有測試。
- 本 Change 的審查證據不只依賴被審查的掃描器。
- 依撰寫者驗收 Gate，由非撰寫者完成驗收。

## 非目標

- 不放寬其他 Secret 類別（provider key、cloud access key、private key、bearer token、JWT）。
- 不處理其他語言的空值字面（例如 None、undefined、nil），也不處理 null 後接右括號或右中括號的情況；這些維持既有行為，列為已知限制。
- 不修改 adapter 的 evidence gate、讀取稽核或 CurrentState 轉換。
- 不補寫 `934b2d5` 當時的授權，也不改寫 F-L1 的歷史紀錄。
- 不修改 `.claude/hooks/**`、`.claude/settings*.json` 或 Master 授權檔。

## 風險

| 風險 | 緩解 |
| --- | --- |
| 排除條件過寬，放過真實憑證 | 規格與測試同時要求 4 個反例仍命中；雙版本掃描確認舊規則多出的命中都是 bare null |
| 掃描器替自己的審查背書 | review capture 必須附雙版本掃描證據；不符合時 review 視為 `INCOMPLETE` |
| 測試 fixture 本身形似憑證，Qwen 讀取後原始輸出被抑制 | review prompt 以文字描述案例，不要求 Qwen 讀取 fixture 原文；測試結果由 Codex 的證據提供 |
| 撰寫者自我驗收 | `934b2d5` 由 CCR 撰寫，採納結果由 Codex 產出；兩者都不能單獨驗收，須依 Master 決定（見 design D4） |

## 回滾策略

若審查或驗收否決 bare null 規則，由 Master 決定是否 revert `934b2d5`。revert 後 F-L1 的 review-result-04 會在舊掃描器下重跑，含 bare null 授權欄位的輸出會再次觸發 `raw_output_contains_secret`，需另開 Change 處理 Qwen 的輸出格式。本 Change 不新增程式碼，回滾不涉及資料遷移。
