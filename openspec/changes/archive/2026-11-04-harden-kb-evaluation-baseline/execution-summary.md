# Execution Summary

## 實際完成內容與 Design 差異

- 完成五階段延遲、90 題 kb-eval-v2（模板 60、人工 30）、組成與來源隔離驗證、凍結 Gate、CLI 選集、分層報表及人工題提升判定。
- 保留 eval_case@1 與整題 latencyMs 語意，不變更線上檢索、Frontend、BFF 或 Tool 契約。
- 仲裁補充 M1 跨語言樣本分配、M2 失敗延遲統計邊界與 M3 降級計數的 dev/test 隔離；Design 未回寫。
- 24 項必做已完成，9.1 選做未選。Archive r1 已同步新增 9 項 Requirement、40 個 Scenario，封存四件套內容維持不變；本輪僅修正主 spec 檔尾空行並補交付記錄。

## 主要修改檔案

- 評測程式與測試：backend/src/knowledge/evaluation/ 下的 runner、stage-latency、dataset-loader、dataset-v2、report、evaluate.cli、opik-publisher 及相鄰測試。
- 建構與資料：backend/scripts/knowledge/build-eval-dataset-v2.ts；backend/data/knowledge-eval/kb-eval-v2.json、kb-eval-v2.freeze.json。
- 正式規格：openspec/specs/retrieval-evaluation/spec.md。
- 本封存目錄保存 proposal.md、design.md、tasks.md、specs/retrieval-evaluation/spec.md 與本 execution-summary.md；本輪不改既有四件套。

## 驗證結果

- r3 lint（26 項 additive migration 與 TypeScript）、build、strict validate 通過；完整回歸 2289 passed、117 skipped，278 個檔案通過、13 個檔案跳過。
- Readiness r2 已核對 r3 原始輸出與摘要一致，判定 READY_TO_ARCHIVE。
- Archive r1 的全域 strict validate 為 81 passed、0 failed；其唯一交付失敗是 CLI 在主 spec 檔尾多產生空行。
- 本輪執行 git diff --check 與 openspec validate --all --strict；實際命令、退出碼與輸出保存於本 Change artifacts/archive-result-r2.json，不在本摘要複製完整 log。
- 本輪未重跑 backend lint/test/build；未執行 v2 live、真實模型延遲 smoke test 或 Opik 上傳。

## 接受的風險與理由

- R-B1：CCR 曾在 writeScope 外建立並刪除暫存檔。Master 決定「承認違規並接受結果」，不重做技術結果；原紀錄保留、不追認合法、不補授權。糾正措施：暫存檔只放 session scratchpad。
- 歷史 CRLF 缺陷：實作驗證期間，既有 commerce 測試在 CRLF 檢出失敗。CCR 允許兩份 golden JSON 還原為 index LF 後補跑；前後 diff 為空，work/index blob 相同。本 Change 不修正該缺陷，本輪不重驗該環境。
- Minor 1：EvaluationRun.strata 預計算與報表重算有冗餘，無功能影響，接受現狀以保留 JSON 消費者資料。
- Minor 2：provenance.method 仍含 not yet Master reviewed；審閱以 freeze.review 為準。為保持已凍結雜湊接受現狀；若修改內容須發布新資料集版本。
- CLI 同步的檔尾空行依 archive-arbitration 分類為格式缺陷，本輪只移除空行，不回滾封存或改動 Requirement。

## 未完成項目

- Task 9.1 為未選的選做 script，不阻擋本 Change 完成。
- v2 live 評測、真實模型階段延遲及 Opik 上傳屬非目標，後續由 1B-2 執行。
- 117 項既有條件跳過測試未視為已執行。
- 人工 Git commit/push 尚待完成；封存狀態仍為 NON_TERMINAL。

## 重要決策與取捨

- 先合併的 commit 16e9959、3639d03、0a2d2dd、0b950ae 與 merge 2985e81，由 Master 明確指示產生；依 archive-arbitration，此為 Master 指示的例外，不在 hitl-git-gate 建議 commit 的情境內。Agent 未執行 commit/push。
- Runner 以裝飾器量測，避免更動線上 retrieval；先分區語料再取樣，以獨立驗證器與 union-find 防止分割洩漏與 v1 dev 校準污染。
- Master 已核准 30 題人工草稿；v2 凍結 90 題，contentSha256：d5bbc21529c931dd6536dc0cbc842448b564bc31e3f3873e56e141c71f05af6d。
- 提升判定只使用人工題分層，須同版本／同雜湊、完成執行且 n≥5；模板只作診斷，差異小於一題解析度不得視為提升。
- Query 模式為 raw_question，離線分數不代表線上端到端品質。R-B1 處置保留原違規，兩項 Minor 保持 accepted_as_is。
- 來源：本 Change 的 CurrentState、implementation-result.json、readiness-result-r2.json、archive-result.json、coordinator-result-archive-arbitration.json、coordinator-result-r-b1-disposition.json、coordinator-result-review-result-arbitration.json、coordinator-result-crlf-arbitration.json 與 evidence/r3-validation-summary.json。

## Commit 建議

- Git commit/push 由人工執行。完整 commit message 建議僅在 CurrentState 確認 ARCHIVED_AWAITING_HUMAN_COMMIT 後，於最終聊天交接提供。
- 本摘要是執行記錄，不取代 proposal、design 或 spec，也不追認歷史違規。
