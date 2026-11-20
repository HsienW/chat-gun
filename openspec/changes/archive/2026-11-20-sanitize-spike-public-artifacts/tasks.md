## 0. 範圍限制

範圍限制：只可修改 `deploy/self-hosted-runtime/`（依 design D-1、D-2、D-3）與封存 spike `openspec/changes/archive/2026-11-19-spike-mit-langgraph-server/findings.md` 的重現段落（design D-5），以及本 Change 的 OpenSpec 檔案。MUST NOT 修改 frontend、bff、backend、其他 Change（含 `demo-predeploy-cost-and-packaging`）、主規格既有 Requirement、根規則或設定；MUST NOT 改寫 Git 歷史；MUST NOT 讀取或刪除 Git 忽略的本機檔案。

## 1. 前置確認

- [x] 1.1 確認下游依賴只指向保留集合。對應 Requirement：「公開保存的 runtime 產出只含可對外內容」（Scenario「下游仍依賴已移除的檔案」）。驗證：`rg -n "self-hosted-runtime" openspec docs --glob '!openspec/changes/archive/**' --glob '!openspec/changes/sanitize-spike-public-artifacts/**'` 的每筆命中只引用目錄、Dockerfile 或啟動入口；任一命中引用 D-2 的檔案則停止並回報 CCR。
- [x] 1.2 記錄移除前的建置基準。驗證：`git ls-files deploy/self-hosted-runtime` 清單與 `Dockerfile`、`Dockerfile.dockerignore`、`start-runtime.mjs`、`runtime-entrypoint.sh` 的 SHA-256 寫入 implementation_result。

## 2. 移除一次性驗證工具

- [x] 2.1 以 `git rm` 移除保留集合以外的全部追蹤檔案（design D-2）。對應 Requirement：同上（Scenario「一次性驗證工具仍可追溯」）。驗證：`git ls-files deploy/self-hosted-runtime` 只剩 D-1 的五個檔案；`git show d4835b5 --stat -- deploy/self-hosted-runtime` 仍列出被移除的檔案；四個保留建置檔的 SHA-256 與 1.2 相同。

## 3. 改寫對外說明文件

- [x] 3.1 依 design D-3 改寫 `deploy/self-hosted-runtime/README.md`。對應 Requirement：同上（Scenario「公開內容不含內部工作流程細節」）。驗證：`rg -n -i "handoff-|currentstate|current-state|\.agent-runtime|master-authorization|attempt|仲裁|codex|qwen|\bccr\b|\.env\.spike" deploy/self-hosted-runtime` 沒有命中；README 包含 D-3 列出的六項內容，並經 Reviewer 人工審查。（人工審查：CCR readiness-result-001）

## 4. 調整封存 findings 的重現段落

- [x] 4.1 依 design D-5，只把封存 spike `findings.md` 中指向已移除腳本的重現說明改為引用 commit `d4835b5`。對應 Requirement：同上（Scenario「一次性驗證工具仍可追溯」）。驗證：`git diff -- openspec/changes/archive/2026-11-19-spike-mit-langgraph-server/findings.md` 只變更重現說明；`rg -n "node deploy/self-hosted-runtime/" openspec/changes/archive/2026-11-19-spike-mit-langgraph-server/findings.md` 沒有指向目前 tree 已不存在的腳本。

## 5. 建置回歸

- [x] 5.1 以保留檔案建置兩個映像。對應 Requirement：同上（Scenario「保留內容滿足下游部署」）。驗證：從 repository 根目錄執行 `docker build -f deploy/self-hosted-runtime/Dockerfile --target runtime -t chat-gun-runtime-sanitize:local .` 與 `docker build -f deploy/self-hosted-runtime/Dockerfile --target bff -t chat-gun-runtime-sanitize-bff:local .` 成功；`docker image inspect chat-gun-runtime-sanitize:local --format '{{json .Config.Entrypoint}}'` 與 Dockerfile 的 ENTRYPOINT 相同。Docker 不可用時標示未驗證，不得推定通過。

## 6. 整體檢查

- [x] 6.1 `openspec validate sanitize-spike-public-artifacts --strict` 通過；`git diff --stat` 與 `git status --short` 只包含第 0 節允許的路徑；implementation_result 列出未執行的驗證與理由。
