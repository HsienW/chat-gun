# Execution Summary

## 實際完成內容與 Design 差異

本 Change 完成四個 Graph 的編譯與 checkpointer 靜態盤點，以 `langgraph dev` 驗證 Run／Thread API、stream、interrupt、正常停止後重啟、resume、無副作用執行中 cancel 與 terminal lookup，並將責任歸屬、identity 權威來源及六項 failure drill 收斂至 `docs/decisions/current-langgraph-runtime-boundary.md`。26/26 Tasks 已完成，沒有修改 application code。

動態驗收依 2026-09-19 核准修訂改用 `langgraph dev`。原先的 Docker Agent Server／PostgreSQL／Redis 驗收路徑因原版 Dockerfile 的 `patch-package` 安裝失敗與 LangSmith 授權 403，移至後續 Change。Decision Record 將開發模式實測標為 V，沒有把 V 推論為正式部署的 L 證據。

Qwen `review-result` 判定 APPROVE（0 Blocker、0 Major、1 Minor），CCR `readiness-check` 判定 READY_TO_ARCHIVE。MIN-1 的兩個 resume checkpoint ID 已依同次執行保存的 `dev-chat-deep-spike.json` 更正，並在 Decision Record 加註 provenance；原始 JSON 未改動。

## 主要修改檔案

- `docs/decisions/current-langgraph-runtime-boundary.md`：X11 Decision Record、MIN-1 修正與 X12 正式部署持久化決策約束。
- `openspec/changes/archive/2026-09-19-reverify-current-langgraph-runtime-boundary/`：保留 proposal、design、delta spec、26 項 Tasks 與本摘要。
- `openspec/specs/langgraph-runtime-boundary/spec.md`：歸檔時同步新增 7 項 Requirement。

## 驗證結果

- apply-change 階段：四個 Graph 的 interrupt／正常重啟／resume 對照完成；`cancel_probe` 的 running → cancel HTTP 204 → interrupted → terminal lookup 為 interrupted。`mcp_agent` 首次 resume 發生 `TypeError: fetch failed`，同 Thread 在沙箱外重試成功，失敗紀錄保留。
- backend lint、build 通過；全量測試 930 passed／45 skipped；目標測試 14/14；worker queue signal live spike 1/1。
- Qwen review 與 CCR readiness gate 通過；OpenSpec 嚴格驗證與 `git diff --check` 通過。歸檔 CLI 成功建立主規格並移動 Change；CLI 對 proposal 缺少英文 `Why`／`What Changes` 標題提出非阻斷格式警告。
- 完整本機執行輸出與摘要位於 `.agent-runtime/reverify-current-langgraph-runtime-boundary/evidence/`；此區域為 latest-only、未納入 Git，長期結論以 Decision Record 為準。

## 接受的風險與理由

- `langgraph dev` 的 V 證據無法證明正式 Agent Server 的 PostgreSQL／Redis checkpoint 寫入、worker lease、強制 kill durability，或 `MemorySaver` 與 server-managed persistence 的關係。此次以 dev 模式完成核准的 X11 驗收；正式部署維度須由後續 Change 取得 L 證據。
- cancel 實測使用無模型、無 Tool 的獨立 fixture；不能推論外部副作用在取消後的提交狀態。
- Docker Agent Server 的建置與授權阻礙已因驗收範圍修訂而從本 Change 移出，不代表底層問題已修復。

## 未完成項目

- 後續 Change 驗證正式 Server-managed PostgreSQL／Redis persistence、worker lease、強制 kill durability、PG／Redis 故障時的 resume，並處理 Dockerfile 依賴與 LangSmith 授權。
- first checkpoint 前終止、真實 Tool 副作用在 dispatch 與結果持久化之間的崩潰，以及 manifest 隨正式 checkpoint 保存，仍無 live 證據。
- Git commit／push 由人工執行；本 Change 在人工 commit 前維持 `ARCHIVED_AWAITING_HUMAN_COMMIT`、`NON_TERMINAL`。

## 重要決策與取捨

- Chat-Gun 保留業務 Task／Step、可見 generation、side-effect ledger、記憶治理與 recovery 決策；LangGraph dev 提供本次已驗證的 Run／Thread／Graph checkpoint API。正式 Agent Server 的權威歸屬尚待 L 證據。
- `deep_researcher` 的 `MemorySaver` 暫時保留，不做 migration 或移除；與正式 server-managed persistence 的 override／complement／conflict 分類維持未驗證。
- Decision Record 可作為 X12 架構前置；**X12 起任何正式部署持久化決策 MUST 明示「基於未驗證假設」，直到後續 Change 取得 L 證據。**

## Commit 建議

`docs(langgraph): archive X11 runtime boundary decision`

內文建議：歸檔 X11 OpenSpec 並同步 7 項主規格；保存 dev lifecycle 與 cancel 證據結論、修正 checkpoint provenance；明示正式部署持久化仍待 L 證據。由人工檢查差異後執行 commit／push。
