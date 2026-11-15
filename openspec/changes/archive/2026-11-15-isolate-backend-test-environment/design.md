## Context

backend 以 vitest 執行測試，目前沒有 vitest 設定檔，`npm run test` 為 `vitest run`。環境洩漏有三個來源，皆發生在模組載入時：

1. **runtime 設定檔載入**：`backend/src/platform/env.ts` 第 1 行 `import "dotenv/config"`。任何直接或間接 import env 模組的測試都會把 `backend/.env` 載入 vitest worker。dotenv 不覆蓋已存在的變數，所以既有測試只能以「設為空字串」對抗（見 `evaluate-cli.test.ts`、`order-request-golden.test.ts` 的註解），但只 stub provider 變數的測試仍會帶入 proxy 與 Opik 設定。
2. **proxy**：`backend/src/platform/llm-gateway.ts` 在模組頂層呼叫 `configureNetwork()`（`src/platform/network.ts`），讀取 `HTTPS_PROXY`／`https_proxy`／`HTTP_PROXY`／`http_proxy`，有值時以 undici `setGlobalDispatcher(new ProxyAgent(...))` 改寫整個 worker 的全域 dispatcher。來源可以是 `.env`，也可以是開發者 shell（例如系統 proxy 工具）。
3. **Opik 匯出**：`getOpikTracer()` 依 runtime config 的 `opikEnabled`（`OPIK_ENABLED`，預設 false）決定 Noop 或真實 tracer。`.env` 啟用時，LLM span 會在測試中連到 hosted Opik。

既有規格 `backend-test-baseline` 已要求預設套件 hermetic、外部環境測試以專用 opt-in 旗標啟用，但未涵蓋上述三個來源。

本 Change 只涉及 backend。**frontend 與 bff 無變更**；bff 測試不 import backend env 模組，不在範圍內。本 Change 不涉及 Tool 或 MCP 契約，無新增權限面。

## Goals / Non-Goals

**Goals**

- 預設測試程序不讀取 `backend/.env`，並能以自動化測試證明。
- 預設測試程序中 proxy 永遠不被設定、Opik 永遠為 Noop，與開發者 shell 狀態無關；個別測試仍可明確開啟以驗證該行為。
- Opik live smoke 與其他 `*.live*.test.ts` 有專用設定可在真實環境執行。

**Non-Goals**

- 不改變 production 的 env 模組、`configureNetwork` 或 Opik tracer 語意。
- 不修改其他 Change 的測試檔，不修改 `llm-gateway.ts`。
- 不新增全域 egress 封鎖。

## Decisions

### D1：以 vitest 設定在程序層級注入測試環境，而非修改 production 模組

新增 `backend/vitest.config.ts`，以 `test.env` 在每個 worker 載入任何測試檔與 setup 之前寫入下列變數（`test.env` 會覆蓋 shell 中的同名變數）：

| 變數 | 值 | 目的 |
| --- | --- | --- |
| `DOTENV_CONFIG_PATH` | 指向 D2 的 fixture 的絕對路徑（以設定檔所在目錄解析，不寫死磁碟路徑） | 讓 `dotenv/config` 讀 fixture 而非 `backend/.env` |
| `HTTPS_PROXY`、`https_proxy`、`HTTP_PROXY`、`http_proxy` | 空字串 | `getProxyUrl()` 以 `??` 取值，空字串會被取用並因 falsy 直接 return，不設定 dispatcher |
| `NODE_USE_ENV_PROXY` | 空字串 | 避免 Node 內建 fetch 依環境變數自行走 proxy |
| `OPIK_ENABLED` | `false` | `getOpikTracer()` 回傳 Noop |

`dotenv/config` 在 import 時讀取 `DOTENV_CONFIG_PATH`（dotenv 16 的既有功能），因此 env 模組本身不需修改。測試檔內既有的 `vi.stubEnv(...)` 仍在此之後生效，所以需要「Opik 啟用」「proxy 有值」語意的單元測試照常可用。

設定檔必須保留 vitest 目前的預設行為（include／exclude、pool、timeout 不變），只新增 `test.env`、`setupFiles`（若 D3 需要）。實作者 MUST 以「新增設定前後，在乾淨 shell 下的測試檔數與案例數相同」證明沒有改變收集範圍。

**替代方案**

- *把 dotenv 載入從 env 模組移到各 runtime 入口*：根除載入，但涉及 langgraph dev、十餘個 CLI 與 operations 入口，影響 production 啟動路徑，風險與本 Change 目標不成比例。列為後續建議。
- *在每個測試檔 stub proxy／Opik*：無法涵蓋未來新增的測試，且已證明會漏（demo-cost 的測試檔就是反例）。
- *以 `NODE_ENV=test` 在 production 程式碼中分支*：違反「不得為測試新增特殊分支」，且把測試責任漏到 runtime。

### D2：fixture 與來源標記

新增納入版本控制的 `backend/test-support/hermetic-dotenv.txt`，內容只有一行來源標記 `CHAT_GUN_TEST_ENV_SOURCE=hermetic-fixture`，不含任何 Secret、URL 或 provider 設定。檔名刻意不以 `.env` 開頭，避免被 `.gitignore` 與讀取稽核視為 runtime 設定檔；實作者 MUST 以 `git check-ignore` 確認未被忽略。

hermetic 守門測試（D3）在 import env 模組後斷言 `process.env.CHAT_GUN_TEST_ENV_SOURCE === "hermetic-fixture"`，證明 dotenv 實際讀的是 fixture。此斷言不讀取、不比較 `backend/.env` 的任何內容。

### D3：hermetic 守門測試

新增 `backend/src/testing/hermetic-environment.test.ts`（位置可由實作者依既有慣例調整，但 MUST 被預設 include 收集），斷言：

1. 來源標記為 fixture（D2）。
2. 四個 proxy 變數皆為空字串或未設定；`OPIK_ENABLED` 為 `false`。
3. import LLM Gateway 模組後，`console.info` 未輸出 `network_proxy_configured` 事件（以 spy 觀察，spy 在 import 前建立並以動態 import 載入）。
4. `getOpikTracer()` 為 Noop（以既有 `createNoopOpikTracer` 的公開行為或 `opikTracerTestInternals` 判斷，不得新增 production 匯出只為此測試）。

此測試是預設 Gate 的一部分；任何人日後移除 `test.env` 設定，它會失敗。

### D4：專用 live 設定

新增 `backend/vitest.live.config.ts`：

- 不設定 `DOTENV_CONFIG_PATH`、不清空 proxy、不強制 `OPIK_ENABLED`，因此維持目前 runtime 設定檔與 shell 的行為。
- `include` 只收集 `src/**/*.live.test.ts` 與 `src/**/*.live-smoke.test.ts`。
- 檔頭註解說明用途與執行方式。

`backend/package.json` 的 `eval:opik` 改為 `vitest run --config vitest.live.config.ts src/evaluation/opik/experiment.live-smoke.test.ts`。opt-in 旗標（`RUN_OPIK_EVALUATION` 等）語意不變：在 live 設定下，旗標可由 `backend/.env` 或 shell 提供，未啟用時 skip。

預設設定仍會收集 live 測試檔：未啟用 opt-in 時依既有規格 skip；若有人在 shell 啟用 opt-in 卻用預設設定，live 測試因設定缺失而失敗，這是既有規格「啟用 opt-in 但設定缺失 MUST 失敗」的直接結果，不另加特殊分支。實作者 MUST 確認 live smoke 的失敗訊息能讓人看出應改用 live 設定；若現有訊息已列出缺少的設定名稱即足夠，不修改測試斷言。

### D5：不改 demo-cost 的測試檔，以環境矩陣驗證其穩定

`llm-gateway-fallback.test.ts`、`llm-gateway.test.ts`（tracked）與 demo-cost-and-access-guard 未提交的 `llm-gateway.usage.test.ts`、`usage-attribution.integration.test.ts` 不修改。D1 讓它們在 worker 內看不到 proxy 與 Opik，即消除逾時與晚到呼叫的連鎖。驗證方式見 tasks 3.x：在 shell 設定不可達 proxy 與啟用 Opik 的情況下，同組檔案連續執行兩次，案例數與通過數必須相同且全數通過。若 demo-cost 檔案在驗證時已不在工作樹（已提交或移除），以實際存在的檔案為準並在 implementation_result 記錄。

## 與 demo-cost-and-access-guard 的重疊與提交順序

| 檔案 | 本 Change 的動作 | 他方狀態 | 處理 |
| --- | --- | --- | --- |
| `backend/package.json` | 只改 `scripts.eval:opik` 一行 | 工作樹已有不屬本 Change 的 `@gun-ai/harness-*` 版本修改 | 以 hunk 層級暫存，只提交 `eval:opik` 那一行 |
| `llm-gateway.usage.test.ts`、`usage-attribution.integration.test.ts`（未提交） | 只執行，不修改 | demo-cost 所有 | 不 `git add` |
| `src/platform/llm-gateway.ts` | 不修改 | demo-cost 有未提交修改 | 無衝突 |
| 新增檔案（兩份 vitest 設定、fixture、守門測試） | 新增 | 無 | 只提交這些 |

提交順序（commit／push 由 Master 執行）：

1. **先提交本 Change**：本 Change 的新增檔案與 `eval:opik` hunk 不依賴 demo-cost 的任何修改，可以在 HEAD 上獨立成立。提交時只暫存上表列為本 Change 的路徑與 hunk。
2. **再由 demo-cost 重跑 Gate**：demo-cost 的 2.5、5.6、6.3 在本 Change 已存在於工作樹（或已提交）後重跑 backend 完整測試，結果作為其 readiness 證據，之後才提交 demo-cost。
3. 若 Master 決定 demo-cost 先提交，本 Change 仍可在其後提交，唯 `package.json` 需以當時 HEAD 為基準重新確認只差 `eval:opik` 一行。

本 Change 的實作與驗證期間，實作者 MUST NOT 修改、暫存、stash 或還原其他 Change 的工作樹修改。

## Risks / Trade-offs

- **既有測試暗中依賴 `.env` 值** → 以切換前後的失敗差異清單逐一定位，改為測試內 stub；不得恢復載入 `.env` 或放寬斷言。若差異超過預期（例如超過 5 個 suite），停止並回報 CCR 仲裁。
- **`test.env` 覆蓋順序假設錯誤** → 守門測試（D3）直接斷言結果，假設不成立時 Gate 失敗，不會靜默。
- **未來有人在測試中呼叫真實 `configureNetwork` 並傳入 proxy** → 屬於明確 stub 的單元測試，允許；全域 egress 封鎖列為後續建議。
- **live 設定與預設設定行為分歧** → live 設定只收集 live 檔，且不影響預設 Gate。

## Migration Plan

無資料遷移。回滾：刪除兩份 vitest 設定、fixture 與守門測試，還原 `eval:opik`。

## Open Questions

無。
