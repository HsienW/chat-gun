## 0. 前置 Gate

- [x] 0.1 Qwen 完成 review-plan，Blocker 清零，Major 已修正或有明確接受理由。驗證：`review-result-review-plan-003` 由 adapter 保存且 evidence gate 通過（COMMENT_ONLY，0 Blocker／0 Major／2 Minor），CCR 仲裁紀錄寫入 design。
- [x] 0.2 Master 定案 design OD-1 至 OD-3 並寫回 design。驗證：design 不再有未定案的 OD；`openspec validate spike-mit-langgraph-server --strict` 通過。

範圍限制：MUST NOT 修改 `frontend/**`、`bff/**`、`backend/src/**` 與既有測試、既有 `docker-compose.yml` 與 `Dockerfile`、其他 Change 的檔案或規格；MUST NOT 修補或 fork 開源套件；MUST NOT 將帳戶、授權結論或私有部署決策寫入受版本控制的檔案；MUST NOT 提交 secret。

## 1. 自建映像

- [x] 1.1 依 OD-1 新增自建 server 映像設定與只用於本機驗證的 compose 設定（自建 server、BFF demo 模式、Redis、knowledge PostgreSQL），`.langgraph_api/` 掛具名 volume，帳本使用獨立鍵前綴。對應 Requirement：「自建開源 server 映像不依賴專有元件且不修改產品程式」。驗證：映像建置成功；`docker compose config` 成功；BFF ready 成功；缺少模型 API Key 時，自建映像與既有 `langgraphjs dev` 在相同環境下的啟動與 ready 結果一致並記錄兩者輸出（Scenario「缺少必要設定時行為與既有 runtime 一致」）；掃描映像層與設定檔，每筆疑似命中逐筆記錄規則、層、路徑、判讀結論與理由，確認為 secret 者移除後重建重掃，不得以路徑白名單略過（Scenario「映像不含 secret」）；報告記錄套件版本與啟動命令。

## 2. 重啟與異常終止

- [x] 2.0 V0 checkpointer 優先順序（design D-3）：對 `shopping_assistant` 與 `deep_researcher` 各建立 run、重啟，記錄實際生效的 checkpointer 與重啟後狀態。對應 Requirement：「重啟與異常終止的行為以實測證據判定」（Scenario「自帶 checkpointer 的 graph」）。驗證：持久化檔案內容與重啟後讀取結果寫入 evidence；V1 至 V4 的各 graph 預期據此寫入報告。
- [x] 2.1 V1 正常重啟。對應 Requirement：「重啟與異常終止的行為以實測證據判定」（Scenario「正常重啟後等待中的審批可恢復」）。驗證：命令、輸出與時間點寫入 evidence；thread 歷史比對、resume 一次成功、side-effect 計數為 1（不得放寬）；第二次相同 resume 在自建映像與既有 `langgraphjs dev` 相同環境下的 HTTP 回應、run 狀態與 rejected audit 對照並記錄兩者輸出（可沿用 apply-002 已取得的自建映像 V1 證據，只補 `langgraphjs dev` 對照與 audit 查核）。
- [x] 2.2 V2 異常終止三個時點（interrupt 建立後立即、串流進行中、resume 期間）。對應 Requirement：同上（其餘三個 Scenario）。驗證：每個時點記錄終止前後狀態、遺失範圍、最早遺失資料年齡、最近一次寫檔時間、side-effect 計數與 run 最終狀態；遺失範圍超過「最近一次連續至少一個寫檔延遲期間沒有存取之後的全部活動」即不通過（V2(a) 沿用 apply-003 證據依此標準重新判定）；resume 時點須涵蓋 side-effect 已執行而 checkpoint 遺失、審批回到等待中後再次核准的情境，並記錄擋下第二次 side-effect 的機制；任一時點出現重複 side-effect、terminal 回到 running 或無法 deserialize，即標示不通過。

## 3. 串流、取消與相容性

- [x] 3.1 V3 串流與斷線取消，程序參考 `demo-cost-and-access-guard` tasks 6.1。對應 Requirement：「串流、取消與 BFF 相容性維持既有語意」。驗證：事件段數與時間、斷線後 run terminal 狀態與時間、lease 釋放紀錄寫入 evidence。
- [x] 3.2 V4 以瀏覽器經 BFF 操作 Gun Chat、深度研究開關與 Gun Shop 審批。對應 Requirement：同上。驗證：操作步驟、截圖或 Playwright 紀錄寫入 evidence；確認 BFF 與 frontend 無程式修改（`git diff --stat`）。

## 4. 資源

- [x] 4.1 V5 依 OD-2、OD-3 的模擬方式（加速、依序、最多 3 並行、每天之間重啟）模擬一週流量並量測。對應 Requirement：「資源用量在門檻內」。驗證：模擬腳本與參數、記憶體與目錄大小的時間序列、重啟載入時間、模擬期間最長未寫檔間隔寫入 evidence；若使用假模型端點，報告註明。

## 5. 結論

- [x] 5.1 撰寫 `findings.md`（design D-5）：V0 至 V5 結果與證據引用、D-4 以 Requirement 為單位的規格偏離表（每條都有判定與證據或理由）、整體建議與條件。對應 Requirement：「可行性結論包含規格偏離分析且不含私有決策」。驗證：每個結論都有 evidence 引用；未執行項目標示未驗證；以搜尋確認報告不含帳戶或授權結論。
- [x] 5.2 整體檢查：`git diff --stat` 只包含 OD-1 指定目錄與本 Change 的 OpenSpec 檔案；`openspec validate spike-mit-langgraph-server --strict` 通過。

## 6. 交付給下游（不在本 Change 內）

- Master 依 `findings.md` 決定是否修改 `demo-predeploy-cost-and-packaging` 的 runtime 與規格偏離聲明。
- 若 V2 不可接受：評估自訂持久化保護或其他方案的後續 Change。
- 部署 Change 須加入停止緩衝時間（讓 SIGTERM 完成寫檔）、server 容器記憶體上限與監控告警，降低 SIGKILL 機率（design「apply-change 003 仲裁（attempt 6）」）。
- 既有產品缺口：replayed resume 在 server 層 no-op 時未明確拒絕、未 audit，另開產品 Change（design「apply-change 002 仲裁（attempt 5）」）。
