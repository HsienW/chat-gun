# normalized-input-query-guard Specification Delta

## Purpose

建立單一 `NormalizedAgentInput` 輸入契約與 generation-based 同步 Query 守衛，使 text、attachments、clarification reply、cancel、command 與 remote input 皆經一個 validated command lifecycle 進入 Runtime，並以既有 `InteractionPolicy` 與 `ActiveRunOwnership` 收斂 enqueue/reject/supersede/clarification-resume，同時以 request idempotency 阻止雙擊／重連／重複提交重複建立 Run 或副作用。

## ADDED Requirements

### Requirement: NormalizedAgentInput 契約與 strict runtime schema

Backend MUST 定義單一 domain 型別 `NormalizedAgentInput`，為 `prompt`／`clarification_resume`／`cancel`／`command` 的判別聯合，並以 strict runtime schema（Zod）驗證。每個輸入源 MUST 產出通過驗證的 `NormalizedAgentInput`；unknown `kind` MUST 回 stable `unsupported_input_kind`，MUST NOT 靜默當成 `prompt`。

#### Scenario: 四種 kind 各有明確 schema

GIVEN 一個受支援的輸入源
WHEN 以 runtime schema 解析
THEN MUST 歸入 `prompt`／`clarification_resume`／`cancel`／`command` 其中之一
AND `prompt` 需非空 `text` 或至少一個 attachment
AND `clarification_resume` 需 `interruptId`
AND `cancel` 的 `targetRunId` 可省略（無 active run hint 時為 no-op）
AND `command` 需 `commandId`

#### Scenario: unknown kind 被拒絕而非當成 prompt

GIVEN 一個 `kind` 不屬於四種已知值的輸入
WHEN 以 runtime schema 解析
THEN MUST 回 `unsupported_input_kind`
AND MUST NOT 將其視為 `prompt` 或建立 Graph Run

#### Scenario: 空輸入於 production fail-closed

GIVEN 一個 `prompt` 輸入既無非空 `text` 亦無 attachment
WHEN 於 production 解析
THEN MUST 回 validation failure（`empty_input`）
AND MUST NOT 以空字串或 placeholder 靜默補齊

---

### Requirement: 單一 readNormalizedAgentInput adapter 作為 transport→domain 唯一映射

Backend MUST 提供單一 `readNormalizedAgentInput` adapter，從 LangGraph input／config metadata／clientInteractionMetadata 建立 `NormalizedAgentInput`；transport type（raw `Message[]`／header／`Command` resume）與 domain 型別 MUST 分離，內部模組 MUST 只消費 `NormalizedAgentInput`，MUST NOT 各自解析 raw key。

#### Scenario: legacy raw input 於單一邊界收斂為 prompt

GIVEN 既有 client 以 raw string 或 `Message[]` 傳入輸入
WHEN 以 `readNormalizedAgentInput` 解析
THEN MUST 經 compatibility adapter 對映為 `prompt`
AND 消費端 MUST NOT 因輸入位置或型別不同而讀到空值

#### Scenario: clarification resume 由 LangGraph Command 映射並附帶 interruptId

GIVEN backend 已 emit `clarification_requested` 事件並附帶穩定 `interruptId`
AND frontend 以 `{ command: { resume: resumeValue }, interruptId }` 送出澄清回覆
WHEN 以 `readNormalizedAgentInput` 解析
THEN MUST 映射為 `{ kind: "clarification_resume", interruptId, value }`
AND MUST NOT 被當成一般 `prompt`
AND MUST NOT 由 adapter 重新推導 `interruptId`

#### Scenario: 直接解析 raw key 被 contract test 阻止

GIVEN 一個模組直接讀取 raw config key 自行解析輸入
WHEN 執行 contract test
THEN 該直讀 MUST 被視為違規
AND 模組 MUST 改經由 canonical adapter 取得 `NormalizedAgentInput`

---

### Requirement: 原始輸入與正規化輸入分離保存

原始輸入（`rawInput`）與正規化結果 MUST 分離保存，MUST NOT 互相覆蓋；正規化只做 trim、Unicode 正規化、空白清理與控制字元移除，MUST NOT 改變使用者語意。

#### Scenario: raw 與 normalized 不互相覆蓋

GIVEN 一次輸入被正規化
WHEN 保存輸入
THEN 原始輸入 MUST 以獨立 reference（`referenceId`／`byteLength`／`hash`）保存
AND 正規化結果 MUST 保有與原始輸入相同語意
AND MUST NOT 以正規化結果覆蓋原始輸入

---

### Requirement: attachment 身份與安全只驗證一次

Attachment 身份與安全 MUST 在 owning boundary（BFF upload-security）驗證一次，queue／後續層 MUST 只存 `AttachmentRef` reference，MUST NOT 重複上傳或重複複製 binary content。

#### Scenario: attachment 驗證一次後以 reference 傳遞

GIVEN 一個含 attachment 的輸入通過 BFF 安全驗證
WHEN 輸入進入 queue 與後續層
THEN 各層 MUST 只持有 `AttachmentRef`（`attachmentId`／`name`／`contentType`／`sizeBytes`）
AND MUST NOT 重複上傳或重複複製 binary

#### Scenario: attachment 不可用或過期回 structured result

GIVEN 一個 attachment 在驗證後不可用或過期
WHEN 輸入進入 Runtime
THEN MUST 回 structured validation result
AND MUST NOT 呼叫模型
AND MUST NOT 以缺失 attachment 建立 Run

---

### Requirement: local/client command 與 model work 分流且不採 NL router

local/client command MUST 在 Graph Run 啟動前與 model work 分流；command 偵測 MUST 採穩定機器識別（`commandId`），MUST NOT 以自然語言關鍵字、Regex 或句型作為主要判定。

#### Scenario: command 由穩定識別分流

GIVEN 一個 `command` 輸入
WHEN 於 Graph Run 啟動前處理
THEN MUST 以 `commandId` 分流
AND MUST NOT 進入 model work 的 Graph Run

#### Scenario: 未接線 command 回 stable 而非當成 prompt

GIVEN 一個 `commandId` 未接線到任何 concrete command
WHEN Runtime 處理
THEN MUST 回 `unsupported_command`
AND MUST NOT 靜默當成 `prompt` 或 model work

#### Scenario: 不以 NL keyword 偵測 command

GIVEN 需要判定輸入是否為 command
WHEN 檢查判定方式
THEN MUST NOT 以自然語言關鍵字、Regex 或固定句型作為主要判定
AND MUST 以穩定 `commandId`／canonical signal 判定

---

### Requirement: generation-based 同步 Query 守衛

Backend MUST 提供 generation-based 同步守衛，狀態機 `idle`／`dispatching`／`running`，以 `(threadId, scopeId)`＋`generation` 為 key；reserve 於 graph node 執行前（in-graph，post-enqueue）同步執行，reject 時立即收斂 terminal，同一 interaction scope MUST NOT 啟動兩個權威 Run。

#### Scenario: reserve 推進 idle → dispatching

GIVEN 一個 interaction scope 處於 `idle`
WHEN 一個 submit 進入 Runtime
THEN 守衛 MUST 同步推進 `idle → dispatching`
AND MUST 以 `ActiveRunOwnership.claim`（durable CAS）為 authority

#### Scenario: 第二個 submit 無法於 dispatch gap 進入

GIVEN 一個 submit 已 reserve（`dispatching`）但尚未 dispatch
AND 第二個 submit 抵達同一 interaction scope
WHEN Runtime 評估
THEN MUST 依 `InteractionPolicy` 走 supersede／enqueue／reject
AND MUST NOT 盲目建立第二個權威 Run

#### Scenario: 守衛不取代 DB 唯一性

GIVEN 兩個 worker 同時嘗試 reserve 同一 scope
WHEN 執行 reserve
THEN MUST 由 DB CAS 原子解決（恰一個成功）
AND 守衛 MUST NOT 取代 DB 唯一性（Invariant #2）

#### Scenario: reject 收斂到 terminal 且不殘留 ghost run

GIVEN guard 判定 reject（`duplicate_input`／`unsupported_command`／superseded stale run）
AND Run 已由 Agent Server 建立
WHEN 執行 reject cleanup
THEN MUST 立即 `markTerminal` 並 emit 對應 terminal 事件
AND MUST NOT 讓其進入 running
AND MUST NOT 殘留 ghost run

---

### Requirement: generation-aware stale cleanup

守衛 release MUST 為 generation-aware；stale finalizer（舊 generation 的完成／取消回呼）MUST NOT 清除較新 generation 的守衛狀態或 Run。

#### Scenario: 舊 generation finalizer 為 no-op

GIVEN scope `S` 的權威 run 已推進到 generation `N`
AND 一個 generation `< N` 的 finalizer 觸發 release
WHEN 執行 release
THEN MUST 為 no-op（不影響 generation `N` 的狀態）
AND MUST NOT 清除較新 Run

---

### Requirement: 輸入經既有 InteractionPolicy 收斂

`prompt`／`clarification_resume`／`cancel` 輸入 MUST 經既有 `InteractionPolicy` 收斂；`clarification_resume` 依 `clarificationReplyMode` resume 到預期 interrupt，`cancel` 走 `cancel_request` deterministic 分類＋`decideCancellation`。

#### Scenario: clarification_resume 回到等待中的 Task

GIVEN Task `K` 處於 `waiting_confirmation`
AND 使用者送出 `clarification_resume` 且 policy 為 `resume_same_task`
WHEN Runtime 評估
THEN MUST resume 到 Task `K`
AND MUST NOT 另建新 Task

#### Scenario: cancel 走 deterministic cancel_request

GIVEN 使用者送出 explicit cancel signal
WHEN Runtime 分類
THEN MUST 歸入 `cancel_request`（deterministic）
AND MUST 走 `decideCancellation`（依目前 phase 分派補償／校正）
AND MUST NOT 與 transport abort（`thread.stop()`）混為一談

#### Scenario: prompt 依 strategy 處理

GIVEN 一個 active run 期間收到新 `prompt`
WHEN Runtime 評估互動
THEN MUST 依 `InteractionPolicy.strategy`（reject／enqueue／interrupt／supersede／rollback）處理
AND MUST NOT 無條件建立新 Run

#### Scenario: clarification_requested 事件附帶 interruptId

GIVEN backend raise clarification interrupt
WHEN 產生 `clarification_requested` 事件
THEN MUST 附帶穩定 `interruptId`
AND frontend 據此於 resume payload 回傳相同 `interruptId`

#### Scenario: cancel 無 active run hint 時為 no-op

GIVEN 使用者送出 cancel 但無 active run hint（`targetRunId` 省略）
WHEN Runtime 處理
THEN business-cancel MUST 為 no-op（nothing to cancel）
AND transport abort 仍由 `thread.stop()` 負責
AND MUST NOT 以 placeholder `targetRunId` 或 fail-closed 處理

---

### Requirement: request idempotency 阻止重複建立 Run 或副作用

Backend MUST 於 query 時執行 request idempotency；相同 trusted dedup key 的已 completed 請求 MUST 回既有結果／狀態，MUST NOT 重複建立 Run、MUST NOT 重放 side effect。

#### Scenario: 已 completed 的 key 回 duplicate

GIVEN 一個 trusted dedup key 已 `completed`
AND 相同 key 再次提交（雙擊／重連）
WHEN Runtime 執行 idempotency acquire
THEN MUST 歸入 `duplicate_input`
AND MUST 回既有結果／狀態
AND MUST NOT 建立新 Run 或重放 side effect

#### Scenario: failed 的 key 允許新 attempt

GIVEN 一個 trusted dedup key 處於 `failed`
AND 相同 key 再次提交
WHEN Runtime 執行 idempotency acquire
THEN MUST 允許新 attempt（不視為 duplicate）
AND 新 attempt MUST 建立獨立 execution identity

#### Scenario: 無 dedup key 時 pass-through

GIVEN 請求未攜帶 `x-idempotency-key`
WHEN Runtime 執行 idempotency
THEN MUST pass-through（不阻斷既有輸入）
AND MUST NOT 以缺失 key 為由 fail-closed

#### Scenario: trusted dedup key 為權威、priorInput 為 fallback

GIVEN 同時存在 trusted dedup key 與 priorInput byte-level 比較
WHEN 判定 duplicate
THEN trusted dedup key MUST 為權威訊號
AND priorInput byte-level 比較 MUST 僅為無 key legacy client 的 fallback
AND 兩者並存時 MUST 以 trusted key 為準，不得矛盾分類

---

### Requirement: 失敗與取消的 stable outcome

缺 attachment、載入失敗、normalizer 拋錯、queue 不可用、cancel race 皆 MUST 有 stable outcome；cancel 與 dispatch 競速 MUST 收斂到恰一個 terminal ownership 決策。

#### Scenario: normalizer 拋錯釋放 reservation

GIVEN 正規化過程拋錯
WHEN Runtime 處理
THEN MUST 釋放 reservation 並保留 safe retryable 輸入 reference
AND MUST NOT 洩漏原始錯誤內容

#### Scenario: queue 不可用依政策拒絕或降級

GIVEN queue／persistence 不可用
WHEN 輸入進入 Runtime
THEN MUST 依 explicit policy 拒絕或降級
AND MUST NOT 靜默遺失輸入

#### Scenario: cancel 與 dispatch 競速收斂單一 terminal

GIVEN cancel 與 dispatch 同時抵達同一 Run
WHEN Runtime 處理
THEN MUST 收斂到恰一個 terminal ownership 決策
AND MUST NOT 使 terminal state 回到 running
