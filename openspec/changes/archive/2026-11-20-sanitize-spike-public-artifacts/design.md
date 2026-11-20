## Context

`deploy/self-hosted-runtime/` 由 commit `d4835b5` 一次加入，目前在 `master_next` 追蹤 52 個檔案。repository 為 public。唯讀稽核結果：

- 沒有 secret 值、IP、email、姓名；Git 忽略的本機設定檔與 `__pycache__` 沒有進版本控制。
- `@langchain/langgraph-api`／`-cli`／`-ui` 1.4.5 為 MIT；入口只呼叫套件公開 API，沒有 vendor 或修補。
- README 與 17 支腳本含內部工作流程字樣共 95 處；README 描述本機私有設定檔與續作命令。

下游 `demo-predeploy-cost-and-packaging`（進行中）引用此目錄的「映像建置與啟動入口」。

## Goals / Non-Goals

見 proposal。本 design 只決定保留與移除的邊界、對外說明文件內容與跨 Change 協調。

## Decisions

### D-1 保留集合

保留下列檔案，內容不變：

| 檔案 | 理由 |
| --- | --- |
| `Dockerfile` | 下游沿用的映像建置 |
| `Dockerfile.dockerignore` | 建置 context 白名單，排除 `.env*` 與 `*.local` |
| `start-runtime.mjs` | 下游沿用的啟動入口 |
| `runtime-entrypoint.sh` | 映像 ENTRYPOINT |
| `README.md` | 依 D-3 改寫 |

保留檔案中不得出現 D-4 的內部標記。現有四個建置與啟動檔已確認不含這些標記，故不修改其內容。

### D-2 移除集合

從版本控制移除保留集合以外的全部檔案，包括：

- 驗證與對照腳本：`validation*.mjs`、`compare-*.mjs`、`kill-*.mjs`、`stream-cancel-004.mjs`、`restart-approval.mjs`、`checkpoint-priority.mjs`、`positive-smoke.mjs`、`live-client.mjs`、`lease-monitor-004.mjs`、`observations-004.mjs`、`approval-observations-004.mjs`、`resource-*.mjs`、`fake-model-004.mjs`、`*-verdict*.mjs`、`loss-window-003.mjs`、`activity-window-004.mjs`、`inspect-candidates.mjs`、`scan-settings*.mjs`、`finish-apply*.mjs`、`update-findings-004.mjs`。
- 測試：`*.test.mjs`、`test_*.py`。
- 映像掃描器：`scan_image.py`、`inspect_candidates.py`。
- compose：`compose.yaml`、`legacy.yaml`、`negative.yaml`、`resource-004.yaml`。

實作以「保留集合以外全部移除」為準；上列為說明用，若目前 tree 有未列出的檔案，同樣移除並在 implementation_result 列出。

`compose.yaml` 為 spike 驗證專用（含 spike 帳本前綴與驗證用服務），下游 tasks 5.1 會新增自己的 production compose，故一併移除。

本機 Git 忽略的檔案（私有設定檔、`__pycache__`）與 `.agent-runtime/` 不屬本 Change 範圍，不刪除也不讀取。

### D-3 對外說明文件內容

README 只包含：

1. 目錄用途：以未修補的 MIT 開源 LangGraph server 自建 backend runtime 映像；可行性結論見主規格 `self-hosted-runtime-feasibility` 與封存的 spike。
2. 建置：從 repository 根目錄以 `docker build` 指定 Dockerfile 與 `runtime`／`bff` target 的命令。
3. 啟動：入口命令、`RUNTIME_HOST`／`RUNTIME_PORT`／`RUNTIME_WORKERS` 的意義，以及只使用套件公開 `startServer` API、不替換 checkpointer。
4. 套件版本與授權：API 與 CLI 版本由 backend lockfile 鎖定，授權為 MIT；基底映像以 digest 固定。
5. 設定注入：所有 secret 與部署設定在執行時由環境注入，鍵名與說明以 `docs/demo-cost-and-access-guard.md` 為準；目錄內不提供數值預設值。
6. 歷史驗證工具：spike 驗證腳本保存在 commit `d4835b5`，不屬目前 tree。

README MUST NOT 包含：私有或 Git 忽略設定檔的名稱與內容描述、本機續作命令、Handoff／CurrentState／owner／attempt／仲裁等工作流程字樣、本機 Runtime Artifact 路徑、evidence 識別碼。

### D-4 內部標記與檢查方式

內部標記指下列字樣（大小寫不敏感）：`handoff-`、`CurrentState`、`current-state`、`.agent-runtime`、`master-authorization`、`attempt`、`仲裁`、`Codex`、`Qwen`、`CCR`、`.env.spike`。

不使用籠統的 `.local` 後綴樣式：保留檔 `Dockerfile.dockerignore` 以 `**/*.local` 排除建置 context，這是排除規則而非私有設定檔名稱，籠統樣式會在保留集合產生必然誤判；本次 spike 的私有設定檔名稱已由 `.env.spike` 涵蓋。（review-plan-002 Major 修訂）

此清單只用於本 Change 的驗收搜尋，不新增常駐檢查工具，避免把一次性清理變成需要長期維護的封閉清單。主規格以行為描述內容邊界，不列舉字樣。

### D-5 已封存 findings 的最小調整

只修改封存 spike `findings.md` 中指向已移除腳本的重現說明，改為「驗證工具保存在 commit `d4835b5` 的 `deploy/self-hosted-runtime/`」。其他技術結論、量測與已知缺口描述不變。

修改封存 Change 的理由：該段落在目前 tree 會變成失效指引；只改指引、不改結論，維持封存紀錄的可稽核性。

### D-6 跨 Change 協調

- 本 Change 不修改 `demo-predeploy-cost-and-packaging`。
- 驗收前以搜尋確認該 Change 只引用保留集合（建置方式、啟動入口、目錄名稱）。
- 由 Master 轉告該 Change 負責人：tasks 5.1「不修改該目錄既有驗證工具」的前提已不成立，可改為「沿用該目錄的 Dockerfile 與啟動入口」。

### D-7 各套件變更

- **frontend**：無。
- **bff**：無。
- **backend**：無。映像建置仍複製相同的 backend 檔案。

## Alternatives

| 方案 | 結論 |
| --- | --- |
| 刪除整個目錄 | 不採用；下游部署 Change 依賴建置與啟動入口 |
| 搬到 `spikes/` 目錄 | 不採用；內容仍公開，內部工作流程字樣仍在 |
| 只改 README | 不採用；17 支腳本的內部字樣與不可重現的工具仍公開 |
| 同時移除主規格與封存 design 的已知缺口描述 | 不採用；需改多個 Change 且歷史仍保留，效益低；缺口由產品 Change 修正 |
| 改寫 Git 歷史 | 不採用；沒有 secret，public repo 可能已被 fork 或快取 |

## Risks / Trade-offs

- 移除後目前 tree 不能重跑 spike；以 commit 引用保留可追溯性。
- 舊內容仍在歷史中；本 Change 明確不處理。
- 內部標記搜尋是字樣比對，不能證明不存在其他形式的內部描述；README 另以人工審查覆蓋。

## Security

不涉及 Tool、MCP、權限或執行時設定。移除檔案不改變映像內容：`Dockerfile.dockerignore` 原本就只放行保留集合中的兩個腳本。

## Migration / Rollback

無資料遷移。`git revert` 本 Change 的 commit 即可還原。
