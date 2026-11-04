# Design：Frontend 確定性 E2E（X46 第一片）

## 1. 現況（`a090967` 已核對；實作基準 `f5b8163`，`a090967..f5b8163` 未修改本節依據的檔案）

- `frontend/package.json` 沒有 Playwright，`test` 是 `vitest run`。Vitest 預設 include 會收入 `*.spec.ts`，因此 E2E 檔案必須明確排除。
- Frontend 以 `@langchain/langgraph-sdk` 0.0.74 的 `useStream` 連到 `VITE_LANGGRAPH_API_URL`；未設定時用同 origin 的 `/api/langgraph`。Vite `base` 是 `/app/`。dev server proxy 目標寫在 `vite.config.ts`，是 BFF 的本機 port。
- 每次送出都經 `createInteractionMetadataFetch` 加上 `x-request-id`、`x-idempotency-key`，有 active run 時再加 `x-active-run-id`。
- 取消：`handleCancel` 先在本地轉為 `streamCancelled` 並加入「已取消」訊息，接著 `thread.stop()` 中斷 fetch，再送出 `kind: 'cancel'` 的 run，有 active run 時帶 `targetRunId`。
- HITL：`OperationApprovalCard` 有核准、拒絕、撤回三個按鈕。點擊後在父層回報新的 submission 前都鎖住。核准與拒絕以 `command.resume` 送出；撤回送出 `kind: 'cancel'` 並帶 `targetRunId`。送出失敗時卡片保持開啟並顯示錯誤碼。
- 去重：`OperationStatusCard` 在 `deduplicated` 時顯示 `DEDUP_REASON_LABELS[reason]` 與原操作狀態（`data-testid="original-operation-state"`）；找不到原操作時顯示 `originalOperationUnavailable`。去重原因有三種：`committed_result_reused`、`in_flight_duplicate`、`original_outcome_unknown`。
- Clarification：weather interrupt 的 payload 帶 `eventType: 'clarification_requested'` 與符合 `clarification:<64 hex>` 的 interruptId。`handleClarificationResume` 以 `command.resume` 送出所選候選，或送出 `{ cancel: true }`。
- 事件去重：`BoundedRuntimeEventBuffer` 以 `eventId` 去重，並以 `(runId, sequence)` 做 bounded reordering；`runId` 與 authoritative run（`activeRunHint`）不符的 versioned 事件會被丟棄。這段只在 `showActivityTimeline` 為 true 的 agent 生效（Shopping Assistant、Deep Researcher）。Gun Shop 入口對應 Shopping Assistant。
- 逾時：`classifyStreamError` 依結構化錯誤碼（`bff_timeout`、`upstream_timeout`、`timeout`）分類，不讀顯示文字。

## 2. 各套件變更

| 套件 | 變更 |
|---|---|
| frontend | 新增 E2E 目錄（測試、fixture server、情境）、Playwright 設定、E2E 用 tsconfig、`.env.e2e`、`test:e2e` script、`@playwright/test` devDependency；Vitest 排除 E2E；ESLint 對 E2E 加入固定延遲禁用規則；`.gitignore` 加入 Playwright 輸出目錄。產品原始碼原則上不變（D8）。 |
| bff | 無變更。 |
| backend | 無變更。 |
| Repository | 新增 `.github/workflows/frontend-e2e.yml`。 |

本 Change 不涉及 Tool 或 MCP 變更，也沒有新增權限面。fixture server 只綁定 `127.0.0.1`，只在測試期間存在。

## 3. 決策

### D1：同 origin 的 fixture server，模擬 BFF 對瀏覽器公開的介面

E2E 啟動一個 Node fixture server，同一個 origin 提供：

1. `/app/`：`vite build --mode e2e` 產出的靜態檔，也就是實際上線的 bundle。
2. `/api/langgraph/*`：模擬 BFF 對瀏覽器公開的 LangGraph 代理介面，回應依目前情境腳本產生。
3. 測試控制介面：載入情境、釋放 gate、讀取請求紀錄。

每個測試啟動自己的 server（port 由作業系統分配），測試之間不共用狀態。

> 2026-11-02 修訂：fixture server 與測試在同一個 Playwright worker 行程，控制介面實作為行程內 API（腳本化 run、gate 釋放與到達通知、請求紀錄），不開 `/__e2e/*` HTTP 路由。責任不變，且瀏覽器無法呼叫控制介面。

不採用的方案：

| 方案 | 不採用原因 |
|---|---|
| Playwright `page.route` 直接回應 | `route.fulfill` 一次送出整個 body，無法逐步串流，也看不到瀏覽器中斷連線。 |
| 瀏覽器內 MSW | 需要在產品啟動流程註冊 Service Worker，會改到產品程式碼。 |
| Vite dev server＋proxy | proxy 目標寫死為 BFF port，會撞到本機 BFF；而且 dev server 不是上線 bundle。 |
| 真實 BFF＋假 Backend | 需要 BFF 的認證、限流與逾時設定，且逾時情境要真的等時間。可列為後續一片，驗證 BFF 端到端的中斷傳遞。 |

### D2：E2E build 只用 `--mode e2e` 與受版控的非機密設定

`.env.e2e` 只放非機密值：`VITE_LANGGRAPH_API_URL` 留空，讓 Frontend 走同 origin 的 `/api/langgraph`；其他必要的 `VITE_*`（例如可見 agent）依實際需要設定。不得放入任何 Key、Token 或正式 URL。`envPrefix` 與 `define` 不變。

### D3：取消的驗證邊界

「中斷傳到上游」在本片的意思是：fixture server 觀察到原串流連線在送完之前被瀏覽器關閉，並收到一次帶 `targetRunId` 的 `kind: 'cancel'` 請求。BFF 把中斷傳給 Backend 的部分由 `bff-stream-proxy` 既有測試負責，本片不重複驗證，報告中也不得寫成已驗證端到端取消。

「晚到內容」以兩種管道注入：

1. 連線被關閉後，fixture 繼續嘗試寫入原連線（預期瀏覽器收不到）。
2. 取消請求或下一次請求的串流中，夾帶屬於已取消 Run 的訊息內容、進度或 Terminal 事件。

thread history 若含已取消 Run 的較晚內容，應如何顯示仍是未決問題（見 §5 Q1），本片不驗證。

### D4：情境內容來源與漂移防護

- 情境以型別化資料定義，SSE frame 依 LangGraph SDK 串流協定組成。implementer MUST 以 SDK 實際送出的請求紀錄，確認 fixture 需要的端點清單（建立 thread、run stream、history 等），並寫入 implementation_result。
- versioned runtime event envelope 與 commerce card payload 優先沿用 `src/lib/__fixtures__/` 既有的契約 fixture。
- 載入情境時，每個 envelope 與 card payload MUST 先經 Frontend 既有 parser 驗證為合法；刻意測試無效或未知內容的情境，必須在情境資料中明確標記。驗證失敗時測試失敗，不得靜默略過。
- 錯誤回應使用 BFF 既有 `ErrorEnvelope` 形狀與既有錯誤碼，不新增錯誤碼。

### D5：請求紀錄與失敗條件

- fixture server 記錄每個請求的方法、路徑、`x-request-id`、`x-idempotency-key`、`x-active-run-id`、body 中的 `kind`、`targetRunId` 與 `command.resume`，以及連線是否在回應完成前被關閉。紀錄不含任何憑證，因為測試本來就沒有憑證。
- 情境未定義的請求回應 HTTP 4xx，並記為 unexpected。每個測試結束時，以下任一情況都使測試失敗：有 unexpected 請求、有 `pageerror`、有任何非 test origin 的連線。
- 非 test origin 的連線由 browser context 層級的路由攔截並 abort。

### D6：時序與穩定性

- 串流的每一段由 gate 控制。測試透過控制介面釋放 gate，再用 Playwright 的自動等待 assertion 等 UI 狀態或請求紀錄。
- E2E 原始碼禁止 `page.waitForTimeout` 與以 `setTimeout` 包成的等待，由 ESLint 規則強制。
- 只跑 Chromium。CI 的 `retries` 為 0。驗收時以 `--repeat-each=5 --retries=0` 執行完整套件，結果寫入 evidence。
- 審批卡片的期限時間由情境給遠未來或已過期的固定 ISO 時間，不依賴真實時鐘流逝。

### D7：Selector 與文字

- 優先使用 role 與 accessible name，其次使用既有 `data-testid`（`operation-<toolCallId>`、`original-operation-state`、`approval-deadline`）。`data-operation-state` 是無值的 boolean attribute，不是 `data-testid`，以 `locator('[data-operation-state]')` 定位。
- assertion 需要比對顯示文字時，從既有 label 模組（`commerce-labels`、`runtime-event-config` 等）匯入，不在測試中另寫一份文案。比對可見文字是驗證使用者看到的行為，不是把文案當成狀態來源。
- 例外：文案不在任何 label 模組時（`App.tsx` 的已取消訊息、`WeatherToolResult.tsx` 的 Submit／Cancel 與狀態標籤），測試以常數保留並註明來源檔案，不為此修改產品程式。

### D8：產品程式碼例外

原則上不修改 `frontend/src/`。只有在沒有任何穩定 role 或 accessible name 能定位元素時，才能新增 `data-testid` 或 accessible name，且不得改變行為。每一處都要列在 implementation_result，由 Reviewer 確認。

### D9：E2E 揭露產品缺陷時

如果某個 Scenario 在現有產品上確實失敗（不是 fixture 或測試寫錯），implementer MUST：

1. 停止該項，把失敗案例、請求紀錄與 trace 保存為 evidence。
2. 不得在本 Change 修改產品行為，不得以 `test.skip`、`test.fail`、`test.fixme` 或放寬 assertion 讓套件通過。
3. 回報 CCR 仲裁：另開修正 Change，或由 Master 決定是否接受為已知限制。

Master 接受為已知限制的測試，只能以下列方式處置（見 D11）：

- 以 `test.fail()` 標記，並以 annotation 指向本文件的 KL 編號；原 assertion 一字不改。
- 不得使用 `test.skip`、`test.fixme`、條件式略過或放寬 assertion。
- 產品修正後該測試會「意外通過」使套件失敗；修正 Change MUST 同時移除標記並刪除對應 KL。

未列在 D11 的失敗，仍依本節前述 1～3 處理。

### D10：CI workflow

新增 `.github/workflows/frontend-e2e.yml`，與既有 workflow 一致：

- `ubuntu-24.04`、Node 24、`actions/checkout@v4`、`actions/setup-node@v4`、`permissions: contents: read`。

> 2026-11-04 修訂：runner 由 `ubuntu-latest` 改為固定 `ubuntu-24.04`。`ubuntu-latest` 已遷移到 Ubuntu 26.04，Playwright 1.56.1 不支援該版本，`npx playwright install --with-deps chromium` 直接失敗（PR #169，job 126581585948）。固定 runner 版本也符合本 Change 的確定性目標。其他沒有使用 Playwright 的 workflow 不受影響，維持 `ubuntu-latest`。之後升級 Playwright 時，再評估是否改回 `ubuntu-latest`。
- 觸發：`pull_request` 與 `push`，路徑過濾為 `frontend/**` 與 workflow 本身。
- 步驟：`npm ci` → `npx playwright install --with-deps chromium` → `npm run test:e2e`。
- 設定 `timeout-minutes`；失敗時上傳 Playwright report 與 trace，保存天數設短。
- 不新增 README badge，避免與進行中的 `add-backend-ci-status-badge` 改到同一份 README。workflow 檔名不同（該 Change 用 `backend-ci.yml`），沒有檔案重疊。

### D11：已知限制（2026-11-02 Master 決定）

attempt 2 在實際基準 `f5b81633e7c2023e1f1a10461d69db77689bb686` 上，以 `--repeat-each=5 --retries=0` 穩定重現下列失敗。Master 接受為已知限制；spec 的 Requirement 不變，產品行為不在本 Change 修正。

| KL | Requirement / Scenario | 測試 | 觀察 | 推定根因（未以程式修改驗證） |
|---|---|---|---|---|
| KL-1 | 串流回覆 / 逾時 | `stream.spec.ts`：`a bff_timeout error frame shows timeout semantics`、`a upstream_timeout error frame shows timeout semantics` | BFF 形狀的 SSE error frame 顯示為「代碼: unknown_error」，訊息為空 | `@langchain/langgraph-sdk` 0.0.74 以 `StreamError(data)` 包裝 error frame；`data.error` 為物件時 message 為空，Frontend 的 ErrorEnvelope 解析讀不到錯誤碼 |
| KL-2 | HITL 審批 / 送出失敗 | `hitl.spec.ts`：`a failed submit keeps the card open with the error and code, and can be retried` | 卡片保持開啟、狀態不變、可重送皆符合；不顯示錯誤碼 | 同 KL-1 |
| KL-3 | 使用者取消 / 晚到內容不復活（D3 管道 2） | `cancel.spec.ts`：`content of the cancelled run inside the cancel stream does not revive it` | cancel 請求串流中，屬於已取消 Run 訊息 ID 的 messages chunk 顯示在畫面上 | Frontend 對串流訊息內容沒有依 Run 隔離；與 Q1（thread history）相鄰但不同路徑 |

證據：`.agent-runtime/add-frontend-deterministic-e2e/evidence/defects/`。

處置：上表測試依 D9 以 `test.fail()` 標記，annotation `{ type: 'known-limitation', description: 'KL-n：…' }`。修正需另立 Change（KL-1、KL-2 可同一個，修在 Frontend 錯誤解析層；KL-3 需先決定是產品缺陷或修訂 Requirement）。

attempt 2 另有兩項觀察，不屬本 Change 的 Scenario，列為後續建議：活動時間軸收合後標題按鈕沒有可點擊區域，只能用鍵盤展開；未知 type 的 versioned 事件不進入 reorder buffer，會讓同一 Run 之後的序號停在缺口。

## 4. 情境與注入方式

| Requirement | 情境 | 注入方式 |
|---|---|---|
| 串流 | 逐步、成功、未知事件、中途失敗、逾時 | gate 分段送出 `messages`／`values`；未知 type envelope 與帶未知欄位的已知事件；送出部分內容後送 SSE `error` frame（`upstream_stream_error`）；HTTP 錯誤或 SSE `error` frame 帶 `bff_timeout`／`upstream_timeout` |
| 取消 | 立即、上游、晚到、新回覆 | gate 停在中段；記錄連線關閉與 cancel 請求；D3 兩種管道；取消後第二個情境 |
| HITL | 核准、拒絕、撤回、失敗、連點 | Gun Shop 入口；`tool_authorization_confirmation` interrupt 與 `order_operation_status@1` 卡片；resume 回應改變卡片狀態；resume 請求回應 `ErrorEnvelope`；請求紀錄計數 |
| 去重卡片 | 原操作已知、未知、未知狀態 | 先送原操作卡片再送 `deduplicated` 卡片；只送 `deduplicated`；狀態值不在 `ORDER_OPERATION_STATES` 的卡片 |
| Clarification | 選擇、取消、失敗 | weather interrupt payload 帶候選與有效 interruptId；resume 後送完成回覆；resume 回應錯誤 |
| 事件去重 | eventId、sequence、過期 Run、訊息 ID、Terminal 重播、重複提交 | 同 `eventId` 送兩次；window 內調換 `sequence`；不同 `runId` 的 envelope；同 id 訊息重送；Terminal 後重送 Terminal 與舊進度；Enter 與按鈕連續觸發 |

## 5. 未決問題

- **Q1**：取消後若 thread history（伺服器狀態）含有已取消 Run 的較晚內容，畫面應以伺服器狀態為準，還是維持本地的已取消訊息？目前程式以伺服器 thread state 為 commerce 狀態依據，但沒有規範訊息內容。本片不驗證這條路徑，建議 Reviewer 確認是否需要另立規格。
- **Q2**：X46 原文要求 E2E 在 CI 執行；本片把 workflow 放在 Frontend 路徑過濾下，不設為 branch protection 必要檢查。是否設為必要檢查由 Master 決定。

## 6. 風險

見 proposal「風險」。另外：

- Playwright 瀏覽器下載會讓 CI 變慢。只裝 Chromium，並以路徑過濾限制觸發。
- fixture server 的 SSE 格式若與 SDK 未來版本不同，升級 SDK 時 E2E 會失敗。這是預期的警訊，不是 flaky。
