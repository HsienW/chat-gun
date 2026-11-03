## Context

現況基準為 `origin/master_next`（`e063cdf`，內容與 `740cc4e` 相同）。工作目錄中未提交的 F-L1 變更不屬於現況。

- Repo 為 `HsienW/chat-gun`。預設分支 `master_next` 與 public 狀態由 Master 查證，CCR 在本次規劃中未能獨立核對。
- `.github/workflows/` 只有兩個 harness workflow。`harness-registry-integration.yml` 使用 Node 24、`actions/checkout@v4`、`actions/setup-node@v4`、`contents: read`、45 分鐘 timeout，PR 觸發帶路徑過濾。
- `backend/package.json`：`lint` 為 `migrations:check` 加 `tsc --noEmit`；`build` 為 `tsc --noEmit`；`test` 為 `vitest run`；`postinstall` 為 `patch-package`。
- Master 提供的實際耗時：2026-10-29 的 harness 成功執行中，Ubuntu 的 backend 安裝、lint、test、build 合計約 2.5 分鐘；BFF 與 frontend 合計約 1 分鐘，且都通過。CCR 未能獨立核對這些數字。

### 各套件變更

- **frontend**：無變更，不納入本 workflow。
- **bff**：無變更，不納入本 workflow。
- **backend**：程式、測試與 `package.json` 無變更，只作為被驗證對象。
- **Repository 層**：新增 `.github/workflows/backend-ci.yml`，三個 README 只新增行。

本 Change 不新增或修改 Tool、MCP，不需要 Tool 權限分析；CI 權限分析見決定 4。

## Goals / Non-Goals

**Goals：** PR 上有真實的 backend 驗證結果；徽章只反映 `master_next` 的 push 結論；README 明確揭露範圍。

**Non-Goals：** 驗證 README 評測數字、資料庫或模型整合測試、live 評測、frontend 與 BFF、required status check、branch protection、harness workflows 調整。

## Decisions

### 1. 獨立 workflow 與單一 runner

新增 `.github/workflows/backend-ci.yml`，名稱 `Backend CI`，job ID `backend-validation`，使用單一 `ubuntu-latest`、Node 24，`defaults.run.working-directory: backend`。

理由：徽章以 workflow 為單位，獨立才能保持語意單純。Windows 覆蓋由 harness workflow 保留。替代方案是擴充 harness workflow，但它的路徑過濾與整合責任不同，因此不採用。

### 2. 觸發

`pull_request` 不設路徑過濾；`push` 只限 `master_next`；另加 `workflow_dispatch`。

理由：路徑過濾可能漏掉共享設定或根目錄依賴的影響，且被跳過的 workflow 日後若設為 required check 可能持續 Pending。`push` 限定預設分支，可避免同一提交在 PR 分支重複執行。`workflow_dispatch` 要等 workflow 進入預設分支後才能使用，因此合併前的遠端驗證一律透過 PR。

### 3. 步驟

依序為 checkout（`persist-credentials: false`）→ setup-node（npm cache，`cache-dependency-path: backend/package-lock.json`）→ `npm ci` → `npm run lint` → `npm run test` → `npm run build`。

每個命令獨立成一個 step，step ID 為 `install-backend`、`backend-lint`、`backend-test`、`backend-build`。保留 `postinstall`，因為 `patch-package` 必須執行。不使用 `--ignore-scripts`、`|| true` 或 `continue-on-error`。

目前 `lint` 與 `build` 都會執行 `tsc --noEmit`，型別錯誤會先在 lint 失敗，所以 build 失敗目前無法單獨觸發，也不需要另做探針。保留 build step 是為了讓這些正式入口日後演進時，CI 能自動跟上。

### 4. 權限與環境隔離

`permissions` 只給 `contents: read`，不注入任何 secret。

| 環境變數 | 設定 | 理由 |
| --- | --- | --- |
| `RUN_OPIK_EVALUATION` | `'false'` | 明確關閉 live 評測 |
| `RUN_QWEN_LIVE_SMOKE` | `'false'` | 明確關閉 live smoke |
| `RUN_DEEP_RESEARCHER_WEATHER_LIVE_SMOKE` | `'false'` | 明確關閉 live smoke |
| `OPEN_METEO_LIVE_SMOKE` | `'false'` | 明確關閉 live smoke |
| `OPIK_ENABLED` | `'false'` | 避免連線 Opik |
| `DATABASE_URL` | `''` | 沿用 harness 慣例；`runtime/__tests__/integration.test.ts` 以 falsy 判斷略過 |
| `T0_POSTGRES_URI` | 不設定 | `postgres-store.compatibility.test.ts` 以 `=== undefined` 判斷，設成空字串反而會執行 |
| `SIDE_EFFECT_INTEGRATION_DATABASE_URL` | 不設定 | 未設定時略過 |
| `KNOWLEDGE_TEST_DATABASE_URL` | 不設定 | 未設定時略過 |
| `LANGGRAPH_SPIKE_BASE_URL` | 不設定 | `worker-queue-signal.live-spike.test.ts` 以 `=== undefined` 判斷 |

設定集中於新 workflow，不修改共用 runtime 預設值，以免影響本機 live smoke 或其他 workflow。

### 5. `timeout-minutes: 15`

不採用 P3 草案的 45 分鐘。依據是 backend 全流程實際約 2.5 分鐘，15 分鐘約為六倍餘裕，同時能較快發現卡住的測試。首次遠端結果若顯示餘裕不足，應依證據另行調整。

### 6. Concurrency

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

Group 包含事件類型，所以 PR 與 push 不會互相取消；包含 PR 編號，所以不同 PR 也不會互相取消。`cancel-in-progress` 只在 PR 為 true，預設分支上執行中的驗證不會被取消。

平台限制：同一 group 最多只有一個執行中與一個等待中的 run。即使 `cancel-in-progress` 為 false，等待中的舊 run 仍可能被更新的 run 取代。因此預設分支短時間內連續 push 時，中間某次提交可能沒有完成的驗證。本 Change 接受這個限制，徽章仍反映最後完成的 push 結論，Spec 也只保證執行中的 run 不被取消。

### 7. 徽章

繁中版的新增行如下，另兩個語言版本相同：

```html
  <a href="https://github.com/HsienW/chat-gun/actions/workflows/backend-ci.yml?query=branch%3Amaster_next+event%3Apush"><img src="https://github.com/HsienW/chat-gun/actions/workflows/backend-ci.yml/badge.svg?branch=master_next&event=push" alt="Backend CI" /></a>
```

插入位置是徽章區塊 `PostgreSQL` 那一行之後、`</p>` 之前。格式沿用既有 HTML `<a><img>`。不放靜態綠色備援圖；沒有紀錄時如實呈現。明確綁定 `branch` 與 `event`，避免 PR 結果或其他分支的結果影響徽章。

### 8. README 範圍說明

三個語言版本都只在評測章節結尾新增一段一句話，位置是「完整結果…」那一段之後、下一個 `##` 標題之前。不刪改既有行，評測數字不動，`docs/evaluation.md` 不動。

草稿如下。**定稿前須以實際測試輸出核對所列測試確實執行**；CCR 目前只有靜態證據，見 Open Questions。

- 繁中：`**CI 範圍：** [Backend CI](<執行紀錄連結>) 徽章只代表 backend 的 lint、預設測試與 build，包含 deterministic Weather Golden Eval、評分器單元測試與 mock integration；不包含需要資料庫或模型的整合測試與 live 評測，不涵蓋 frontend 與 BFF，也不代表本章節的評測數字。`
- 简中：`**CI 范围：** [Backend CI](<执行记录链接>) 徽章只代表 backend 的 lint、默认测试与 build，包含 deterministic Weather Golden Eval、评分器单元测试与 mock integration；不包含需要数据库或模型的集成测试与 live 评测，不涵盖 frontend 与 BFF，也不代表本章节的评测数字。`
- 英文：`**CI scope:** the [Backend CI](<runs link>) badge covers only backend lint, default tests, and build, including the deterministic Weather Golden Eval, scorer unit tests, and mock integration; it excludes integration tests that need a database or model and live evaluations, does not cover frontend or BFF, and does not represent the evaluation numbers in this section.`

句中的文字連結同時滿足徽章圖片載入失敗時仍可抵達執行紀錄的要求。這句話是必要的，因為 README 的流程評測「deterministic 10/10」需要資料庫，不是由這條 CI 驗證。

### 9. frontend 與 BFF 不納入

理由：狀態徽章以 workflow 為單位，併入後 frontend 失敗也會讓 Backend CI 變紅，語意失真；本次範圍也限定 backend。成本不是障礙，兩者合計約 1 分鐘。README 明寫這個缺口。建議之後各開獨立 workflow 與徽章。

### 10. 不設 required status check

不改 branch protection、harness workflows、`backend/package.json` 或任何測試。Workflow 穩定後，是否設為 required check 另由 Master 決定。

## Risks / Trade-offs

- **既有問題在乾淨 runner 暴露** → 保留證據另行定位，不降低 Assertion。若阻擋本 Change，回到 CCR 仲裁。
- **Timeout 與取消在 UI 上可能顯示相同結論** → Spec 只要求「不為成功」且可辨識原因；實際結論以遠端驗證紀錄為準，不預先假設。
- **徽章首次顯示** → 合併前 `master_next` 沒有這個 workflow，徽章在首次 push 完成前可能顯示無狀態或無法載入；同一 PR 合併後才會有紀錄。第三個驗收點要在合併後確認。
- **臨時驗證分支污染 diff** → 失敗、逾時探針只放在獨立臨時分支與 Draft PR，驗完關閉並刪除，最終 diff 由 Tasks 檢查。
- **README 換行符** → 工作目錄的三個 README 為 CRLF。實作須保留既有換行符，否則 `--numstat` 會顯示大量刪除。
- **重複驗證** → 與 harness workflow 部分重複，先保留。

## Migration Plan

沒有資料或契約遷移。依序合併 workflow 與 README，合併後確認首次 push 結果。回滾方式是撤回新增的 workflow 與 README 新增行。

## Open Questions

- `npm run test` 的實際輸出尚未核對。靜態上，`weather-golden-eval.test.ts`、`evaluation/opik/metrics/response-quality.test.ts`、`tool-call-correctness.test.ts` 沒有環境變數略過條件。實際輸出由 Task 2.2 核對，通過後才依 Task 5.2 寫入 README。
- 「mock integration」目前只在 `weather-golden-eval.test.ts` 找到對應字樣，範圍說明的用語須一併核對。
- `master_next` 的 branch protection 細節未確認。
- 新 workflow 的首次實際結果未知。
