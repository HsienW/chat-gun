## 0. 施工前提

- 只有在 review-plan 通過且 Master 同意後才能開始。
- 基準為 `origin/master_next`，在乾淨工作樹施工，不得在有 F-L1 變更的主工作目錄施工。
- 以下命令未註明時，於工作樹根目錄執行。

## 1. Workflow

- [x] 1.1 確認基準與預設分支。
  驗證：`git ls-remote --symref origin HEAD` 顯示 `refs/heads/master_next`；`git status --short` 無輸出。
- [x] 1.2 新增 Backend CI workflow，完成 Design 決定 1–6 的觸發、權限、環境隔離、步驟、timeout 與 concurrency。
  驗證：`actionlint .github/workflows/backend-ci.yml` 通過。若工具不可用，記錄為未執行，改以 3.1 的首次遠端解析作為語法證據。
- [x] 1.3 靜態確認 workflow 沒有禁止項目與 secret。
  驗證：`git grep -n -E "ignore-scripts|\|\| true|continue-on-error|secrets\.|paths:|T0_POSTGRES_URI|SIDE_EFFECT_INTEGRATION_DATABASE_URL|KNOWLEDGE_TEST_DATABASE_URL|LANGGRAPH_SPIKE_BASE_URL" -- .github/workflows/backend-ci.yml` 無輸出。

## 2. 本機通過（驗收點一）

- [x] 2.1 在未設定任何資料庫變數與 live 開關的環境，乾淨安裝並通過全量驗證。
  驗證（於 `backend` 執行）：`npm ci`、`npm run lint`、`npm run test`、`npm run build` 全部結束碼為 0。
- [x] 2.2 核對測試範圍，確認 Design 決定 8 列出的測試確實執行，資料庫與 live 測試確實略過；輸出與範圍說明不符時停止並回報 CCR，不得自行改寫範圍。
  驗證（於 `backend` 執行）：`npx vitest run --reporter=verbose src/tools/weather-golden-eval.test.ts src/evaluation/opik/metrics` 顯示通過且沒有略過；`npm run test` 摘要的 skipped 檔案與 Design 決定 4 的條件一致。

## 3. PR 通過（驗收點二）

- [x] 3.1 開 PR 到 `master_next`，確認 Backend CI 觸發且四個步驟各自顯示成功。
  驗證：`gh pr checks <pr>` 顯示 `backend-validation` 通過；`gh run view <run-id> --json jobs` 顯示四個步驟依序成功，並記錄實際耗時。
- [x] 3.2 確認權限、測試隔離與耗時。
  驗證：`gh run view <run-id> --log` 的 `GITHUB_TOKEN Permissions` 只有 `Contents: read`；測試摘要含 skipped；實際耗時低於 timeout。
- [x] 3.3 確認只改非 backend 路徑的 PR 也會觸發。
  驗證：開臨時 Draft PR 修改一個非 backend 檔案，`gh pr checks <temp-pr>` 含 `backend-validation`。驗完依 4.5 清理。

## 4. 失敗、逾時與取消的遠端驗證（僅限臨時分支）

所有探針只放在 `ci-probe/*` 臨時分支與 Draft PR，不得進入最終 diff。

- [x] 4.1 測試失敗：加入一個必定失敗的測試。
  驗證：`gh run view <run-id> --json conclusion,jobs` 顯示 `backend-test` 失敗、run 結論為 `failure`。
- [x] 4.2 安裝與 lint 失敗：分別破壞鎖定檔、加入型別錯誤。
  驗證：`gh run view <run-id> --json conclusion,jobs` 分別顯示 `install-backend`、`backend-lint` 失敗且 run 結論為 `failure`。Build 失敗依 Design 決定 3 無法單獨觸發，須如實記錄。
- [x] 4.3 逾時：把 `timeout-minutes` 改為 1，並加入超過 1 分鐘的等待步驟。
  驗證：`gh run view <run-id> --json conclusion` 不為 `success`；紀錄可辨識超過時間上限。記錄實際結論。
- [x] 4.4 取消與隔離：對同一臨時 PR 連續推送兩次，同時讓另一個 PR 的驗證執行中。
  驗證：`gh run list --branch <temp-branch> --limit 2 --json conclusion,headSha` 顯示舊 run 為 `cancelled`、新 run 有獨立結論；另一個 PR 的 run 未被取消。
- [x] 4.5 清理所有探針。
  驗證：`gh pr list --state open --head <temp-branch>` 無輸出；`git ls-remote origin "refs/heads/ci-probe/*"` 無輸出。

## 5. README

- [x] 5.1 在三個語言版本的徽章區塊新增 Design 決定 7 的徽章行。
  驗證：`git grep -c "backend-ci.yml/badge.svg?branch=master_next&event=push" -- README.md README.en.md README.zh-CN.md` 三個檔案各為 1。
- [x] 5.2 依 2.2 的實際輸出定稿，在三個語言版本的評測章節新增一句範圍說明。
  驗證：`git diff --numstat origin/master_next -- README.md README.en.md README.zh-CN.md` 每個檔案第二欄（刪除行數）為 0。
- [x] 5.3 確認評測數字與評測文件不變。
  驗證：`git diff --name-only origin/master_next -- docs/evaluation.md` 無輸出；5.2 的刪除行數為 0 即代表既有數字行未變。

## 6. 最終 diff 檢查

- [x] 6.1 Diff 只含允許的檔案，且 README 刪除行數為 0。
  驗證：`git diff --name-only origin/master_next...HEAD` 只列出 `.github/workflows/backend-ci.yml`、三個 README 與 `openspec/changes/add-backend-ci-status-badge/**`；`git diff --numstat origin/master_next...HEAD -- README.md README.en.md README.zh-CN.md` 第二欄皆為 0。
- [x] 6.2 OpenSpec 驗證通過。
  驗證：`openspec validate add-backend-ci-status-badge --strict` 結束碼為 0。

## 7. 徽章上線（驗收點三，合併後）

- [ ] 7.1 由 Master 合併後，確認 `master_next` 的 push 執行完成。
  驗證：`gh run list --workflow=backend-ci.yml --branch master_next --event push --limit 1 --json conclusion,headSha` 的 `headSha` 為合併提交，並記錄結論。
- [ ] 7.2 確認徽章與連結。
  驗證：`curl -sL "https://github.com/HsienW/chat-gun/actions/workflows/backend-ci.yml/badge.svg?branch=master_next&event=push"` 回傳的 SVG 狀態與 7.1 一致；瀏覽器開啟三個 README 的徽章連結，都顯示篩選後的執行紀錄。

## 8. 完成回報

- [x] 8.1 回報時分開列出本機通過、PR 通過、徽章上線三個驗收點，以及未執行項目與環境限制。
  驗證：`implementation_result` 的 `verification` 分別列出第 2、3、7 節的結果；`notExecuted` 列出所有未執行項目。徽章上線在合併前必須列為未驗證。
