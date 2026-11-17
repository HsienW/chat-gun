# Execution Summary：一般聊天正文串流

歸檔日期：2026-11-17（系統日期）。執行者：Codex，Archivist primary，rolePolicyVersion 2。本次依 `handoff-archive-01` 與 `coordinator-result-18` 歸檔；四個 Gate 均已通過。本文件保留實際驗證邊界，7.1、7.3 的未完成狀態沒有變更。

## 實際完成內容與 Design 差異

- Task 1：以 Provider gate、真實 LangGraph Server／BFF／瀏覽器確認 custom 橋接；前端 SDK 固定為 0.0.74，承接上游 harness 0.1.0-alpha.4 的正文選用欄位與 strict schema。
- Task 2：新增正文 sink、attempt 封存與晚到片段丟棄；正文發布後，adapter 重試、tool argument 修復、結構化輸出修復、Provider fallback 共用禁止透明重試邊界。
- Task 3：OpenAI-compatible 增量 UTF-8／SSE／surrogate 解碼、首段／閒置／總時限、取消與有界緩衝；每次上游嘗試恰好計量一次，缺用量保留原因，計價與 ledger 儲存格式維持原契約。以五次真實端點量測回填 D8 設定。
- Task 4：chatbot 接入可信 ExecutionContext、task admission 與注入的 process 範圍 allocator；啟用但缺接線時 readiness 失敗。終稿以帶穩定 id 的新 AIMessage 建構，測試同時斷言序列化後的 kwargs.id。
- Task 5：BFF 僅對 SSE 套用 `X-Accel-Buffering: no` 與 `Cache-Control: no-cache, no-transform`，保留背壓、取消與錯誤終止行為。
- Task 6：前端獨立正文入口、runtime validation、ownership、有界草稿、文字偏移接合與終稿對帳；安全 Markdown 按 frame 合併。F1 修復保留 eventId，加入最多 2,048 筆 FIFO 去重，既有偏移／內容去重及 Run 封存保留。
- Task 7：確定性 E2E、既有真實跨層與 live smoke 取得部分證據；兩項未完整驗證的 Task 依 Master 決定維持未勾選。
- Task 8：保留實作、審查、readiness、驗證證據與後續待辦；第二輪 readiness 確認 F1、V1 解除，CCR 最終仲裁同意歸檔。

重要修訂均已記錄於 design：D4 的 chatbot 接線及獨立 allocator；D11 的正文不進入活動 reordering buffer；D12 的兩種 profile 均維持 `on_disconnect: cancel` 並只提供明確重新生成。Runtime Event 主規格依已核准 delta 同步此分流規則。M1「端點回傳整包 JSON 時仍記 capability_unsupported」保留為已接受的 Minor。

## 主要修改檔案

歸檔將原 Change 的 proposal.md、design.md、tasks.md 與四份 delta spec 原樣移至本目錄，另新增本 execution-summary.md。tasks.md 的位元組與勾選保持原樣，30 項勾選、7.1／7.3 未勾選。

同步的主規格：

| 主規格 | 同步內容 |
|---|---|
| `chat-answer-text-streaming` | 新增主規格與全部 11 個 ADDED Requirement |
| `bff-stream-proxy` | 新增 SSE 防緩衝 Requirement；其餘 5 個原樣保留 |
| `runtime-event-contract` | 完整取代前端去重／重排 Requirement，新增正文身分欄位 Requirement；其餘 14 個原樣保留 |
| `model-usage-ledger` | 完整取代缺用量 Requirement；其餘 4 個原樣保留 |

MODIFIED 以 delta 的完整 Requirement（含全部 Scenario）取代；ADDED 只新增。23 個未提及的既有 Requirement 均逐字保留。本輪未修改程式、測試、其他 Change 或 Master 授權檔。

## 驗證結果

本輪歸檔驗證命令與日誌：

- `openspec validate stream-chat-answer-text --strict`：通過，exit 0。
- `openspec validate --specs --strict`：移動後通過，87 passed、0 failed，exit 0。原始輸出與退出碼保存於 `.agent-runtime/stream-chat-answer-text/artifacts/archive-codex-01/validate-main-specs.*`。
- 合併檢查：四份 delta 的 Requirement 全文一致；未提及的既有 Requirement 逐字一致。移動檢查：七個原始文件的 SHA-256 均保持不變，tasks.md 原樣保留。

以下是 `readiness-result-codex-03` 已實際重跑的結果，本輪歸檔沒有重跑套件測試：

| 驗證 | 第二輪 readiness 結果 |
|---|---|
| backend lint／test／build | 通過；306 files、2,548 passed、120 個既有 opt-in／live skipped |
| generation-env 三個案例 | 完整執行，另以 verbose 記錄 3/3 通過（V1 解除） |
| BFF build／test | 通過；224 個 Vitest 與 31 個 Node tests；沒有 lint script |
| frontend lint／test／build | 通過；360 tests；0 lint errors、2 個既有 warning；bundle 690.59 kB，保留既有 chunk-size warning |
| frontend test:e2e | 38 passed，含四項既有 test.fail() 預期失敗 |
| F1 固定 probe | 預期 A、實際 A；同批與跨批交付均通過，第二次不改變 state |

Readiness 的命令串行執行，開始前沒有觀察到其他驗證 session。Agent 未開啟、讀取或搜尋 .env*；既有 npm test 依 Master 允許範圍讀取已提交的範本。

既有 cross-layer evidence 為 8/8，首段 380 ms、同一泡泡追加、終稿帶 id；live smoke 為 qwen3.5-flash，首段 631 ms、53 個樣本、最大間隔 941 ms、總長 4,319 ms，usage 141＋261＝402。這些是先前量測，readiness 與 archive 都只核對證據，沒有重跑 Docker／真實端點。

## 接受的風險與理由

依 `coordinator-result-13`，Master 接受下列限制，後續 readiness 與 `coordinator-result-18` 均保留：

- **7.1 app 重載歷史核對**：app 不持久化 threadId，重新整理回到首頁，改以 thread 權威狀態核對；沒有宣稱完成真正 UI 重載測試。
- **7.3 部署代理與 live ledger**：未有部署代理可做直連對照量測，live 也沒有直接讀取 usage ledger；恰好一次計量由 Task 3 測試支持。上線前仍需在實際代理環境補測。
- Live 腳本使用去空白後的包含比對，沒有獨立證明原始文字逐字相等；cross-layer 的 customFrames 計數未接線，數值 0 不作 frame 數證據。
- Run deadline 尚無設定來源可與串流總時限比較；allocator 以單 process 假設運作，多 worker／多 session 協調屬後續範圍。

Qwen 原審查 APPROVE 經 Master 採用，capture 的 credential_assignment 命中由 CCR 追查為讀取環境變數名稱的誤判，見 coordinator-result-15。F1 修復依 Master 決定直接 readiness，不另送 Qwen 複審；第二輪 readiness 引用具 self_acceptance 的有效授權並保留快照。歸檔本身由 primary Archivist 執行，不讀取或修改 Master 授權容器。

## 未完成項目

- tasks.md **7.1、7.3 維持未勾選**，限制與接受理由如上。
- 120 個既有 opt-in／live 測試未執行；四項 E2E 預期失敗未修復。
- 未額外驗證正式映像的多 process／worker 拓撲、demo composition 的真實 Redis 分支與貼底捲動量測。
- 人工 Git 提交尚未執行；Runtime 在 `ARCHIVED_AWAITING_HUMAN_COMMIT` 保持 NON_TERMINAL，人工提交後再完成流程。

## 重要決策與取捨

後續待辦依 `coordinator-result-18 payload.followUps` 保留，均未在本輪實作：

1. FU-1：demo profile 斷線後重新同步。
2. FU-2：多 worker／多 session 部署下的事件序號。
3. 完整 profile 改為 on_disconnect continue 與 thread_resync。
4. 部署環境經代理的首段量測。
5. threadId 持久化後補做重載歷史核對。
6. 調整 qwen-capture-adapter 的 credential_assignment 規則。
7. 評估 design D9 是否新增「端點未遵守串流宣告」的降級原因。

Runtime 證據位於本機、被 Git 忽略的 `.agent-runtime/stream-chat-answer-text/`，不加入版本控制；歸檔結果列出本輪移動、合併、日誌與驗證的 ArtifactReference。

## Commit 建議

```text
feat(chat): 新增一般聊天正文串流

串接 Gateway sink、LangGraph custom 與前端草稿，保留終稿對帳、
發布後禁止透明重試、串流逾時、拒答與用量計量契約。
同步四份主規格並歸檔 stream-chat-answer-text，保留已接受限制與後續待辦。
```

由 Human 檢閱並提交。本輪沒有 commit、push、stash、切換分支或還原任何人的修改；其他 Change 的既有未追蹤目錄保留原樣，不混入本次歸檔。
