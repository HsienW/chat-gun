# Tasks：擴充 model.stream 回答正文身分欄位（上游 gun-harness）

> 本 Change 的程式修改全部在 `gun-harness` repo；chat-gun 只有本 Change 的 OpenSpec artifacts。每個 Task 完成時必須附上實際執行的命令與結果，未執行的驗證不得勾選。任何步驟失敗，停止並回報 CCR。

## 1. 施工基準

- [ ] 1.1 依 Master 對 design Open Question 2 的決定，在 `gun-harness` 切出施工分支；記錄基準分支、commit SHA 與 `git status` 乾淨證據。
- [ ] 1.2 在基準上執行 `npm ci` 與 `npm run check`，確認修改前全綠，保存輸出作為 baseline。

驗證：`npm ci`；`npm run check`。

## 2. contracts 擴充（design D1、D2；spec「契約驗證」「單一來源」）

- [ ] 2.1 新增 `MODEL_STREAM_OUTPUT_KINDS` 與 `ModelStreamOutputKind`，含 `@since 0.1.0-alpha.4`；經 `src/index.ts` 具名匯出；更新 `api-surface.json` 的 `runtime` 與 `types`。
- [ ] 2.2 擴充 `model.stream` payload schema：三個選用欄位、維持 strict 與既有 `delta` 限制；`outputKind` 由常數推導。
- [ ] 2.3 依 design D6 第 1–7 案新增 contracts 測試。
- [ ] 2.4 確認 API surface 測試：更新 snapshot 後通過；暫時移除 snapshot 中新增名稱時失敗（記錄後還原）。

驗證：`npm run check`。測試輸出須列出 D6 第 1–7 案名稱與結果。

## 3. kernel 與 testkit 驗證（design D3、D6；spec「kernel 解析入口保留身分欄位」）

- [ ] 3.1 依 design D6 第 8–10 案新增 kernel 測試；kernel 原始碼不修改。若測試發現 kernel 剝除欄位，停止並回報 CCR，不得自行加入白名單或轉換。
- [ ] 3.2 檢查 testkit fixture：涉及 payload 透傳時新增一案驗證三欄位不變；不涉及時記錄「不受影響」與檔案依據。

驗證：`npm run check`。

## 4. 版本與 CHANGELOG（design D4、D5；spec「一批精確版本」）

- [ ] 4.1 四個套件 `version` 升為 `0.1.0-alpha.4`；kernel、sdk、testkit 對 harness 套件的相依改為精確 `0.1.0-alpha.4`；更新 root lockfile。`RUNTIME_EVENT_SCHEMA_VERSION` 依 Master 對 Open Question 1 的決定處理。
- [ ] 4.2 四個套件 `CHANGELOG.md` 新增 `0.1.0-alpha.4` 段落，內容依 design D5，含舊版 strict 消費端相容性說明。

驗證：`npm ci`；`npm run check`；以 `git diff` 確認沒有範圍外的套件或檔案變更。

## 5. 發布前驗證（design D7；spec「一批精確版本與核准發布」）

- [ ] 5.1 各套件 `npm pack --dry-run`，保存 tarball 內容清單。
- [ ] 5.2 拋棄式目錄以四個 tarball 安裝 testkit，`npm ls @gun-ai/harness-contracts` 只有 `0.1.0-alpha.4` 一份。
- [ ] 5.3 以 tarball 執行 probe：完整三欄位通過、未宣告欄位被拒、`textOffset: -1` 被拒、只有 `delta` 通過。
- [ ] 5.4 停在發布前，交回 CCR 與 Master：提交 commit SHA、分支、所有命令輸出、tarball 清單與 probe 結果。MUST NOT 執行 `npm publish`、`npm dist-tag` 或推送 tag。

驗證：上列命令輸出以 evidence 保存於 `.agent-runtime/add-model-stream-answer-identity/` 並以 ArtifactReference 引用。

## 6. 發布與交接（Master 執行）

- [ ] 6.1 Master 核准並依 contracts → kernel → sdk → testkit 順序以 `alpha` dist-tag 發布 `0.1.0-alpha.4`。
- [ ] 6.2 匿名環境確認四個套件可安裝（`npm view` 與實際安裝），結果交回 CCR。
- [ ] 6.3 CCR 更新 `stream-chat-answer-text` 的 CurrentState，建立新的 apply-change Handoff，由 Codex 從 Task 1.7 起重跑 Task 1 閘門。

驗證：registry 查詢與匿名安裝輸出；本地連結、pack 或 dry-run 不得作為 6.2 證據。
