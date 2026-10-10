# Proposal：extract-stable-gun-harness-contracts

## 變更摘要

把 Chat Gun 在 X11–X21 已驗證的 runtime contracts，從「實體上嵌在 `backend` 套件內、與 product composition 交織」的現況，抽成 framework-neutral 的 `@gun-ai/harness-contracts`、`@gun-ai/harness-kernel`、`@gun-ai/harness-testkit` 三個 npm 套件，實體歸屬獨立的 `gun-harness` repo 並由 npm 發布；`chat-gun` 改為透過 adapter 消費，不再保有平行本地定義。抽出的只有「有 X11–X21 已驗證語意的契約與無框架依賴的原語」；Chat Gun 的產品政策、UI、Provider credential、concrete persistence、LangGraph 綁定一律留在 `chat-gun`。

本 Change 對應 `second-stage-plan-en-v5.md` 的 **X26**，是 Second Stage — Layer 9（Harness Platform）Wave 1 的 Change；前置 X11–X21 已 archive（X22/X24 同波並行，X25 已 archive）。X26 遵守 invariant #6「Extraction must not fork behavior」：`gun-harness` 只擁有 stable contracts 與 reusable primitives，`chat-gun` 擁有 product composition，並維持「one runtime, multiple surfaces」的單一權威執行路徑。

## 問題描述

盤點確認的關鍵事實（本 Change 建立時，唯讀盤點，file:line 為建立時快照）：

1. **契約實體與 product composition 交織在同一套件**：v4 runtime 的契約集中在 `backend/src/runtime/`（229+ 檔），但全部位於單一套件 `chat-gun-backend`（`backend/package.json:1-8`，`private: true`），直接依賴 `@langchain/core`、`@langchain/langgraph`、`pg`、`ioredis`、`@modelcontextprotocol/sdk`（`backend/package.json:20-37`）。沒有套件邊界把「穩定可重用的 harness contract」與「Chat Gun product composition」分開。

2. **契約已穩定且有正式 spec，但實體位置未反映 framework-neutral 邊界**：主 spec 已存在 `canonical-execution-context`、`task-step-state-machine`、`unified-tool-dispatch-pipeline`、`trusted-tool-authorization`、`side-effect-tool-execution-runtime`、`runtime-event-contract`、`durable-hitl-conversation-recovery`、`provider-tool-call-decoding`、`tool-scheduling-resilience-policy`；對應的 TypeScript 型別卻散落在 `backend/src/runtime/`，且與 LangGraph graph、Postgres/Redis persistence、MCP loader 等 product-specific 程式同目錄。代表性的交織：`backend/src/runtime/types.ts:1-113`（`TaskStatus`/`StepStatus`/`AgentTask`/`AgentStep`/`TaskEvent` 等 task/step/run 生命週期型別）與 `backend/src/runtime/execution-context/execution-context.ts:13-76`（`ExecutionContext` 及其 `executionContextSchema`，直接 import `../authorization/principal.js` 與 `../authorization/scope.js`）。

3. **無公開 API 邊界**：`backend/src/runtime/index.ts:1-9` 以 barrel export 直接輸出 events/lock/persistence/state-machine/types，無「public vs internal」區分、無 API-surface test、無 semver/changelog/provenance policy；任何 internal type 都可能被下游誤當公開契約。

4. **無依賴方向強制**：`runtime/execution-context/execution-context.ts:3-11` 顯示契約型別 import 進 `authorization/` 內（principal/scope/consumer-identity），反向亦存在（`events.ts:2` import `execution-context`）；沒有自動化 check 阻止 contracts/kernel/adapters/product 之間形成 cycle，或阻止 `@gun-ai/harness-*` import React/LangChain/DB client。

5. **失敗分類與事件 envelope 為可重用的 framework-neutral 原語**：`backend/src/runtime/retry/error-classification.ts:3-105`（`ErrorCategory`/`ClassifiedError`/`classifyError`）與 `backend/src/runtime/events.ts:1-103`（`createTaskCreatedEvent` 等 envelope factory）是純函數，不依賴 LangChain/DB，但實體上與 product code 同套件，外部 consumer 無法只取這些原語。

綜合而言，v4 runtime 的契約語意已成熟且被正式 spec 鎖定，但**缺少「穩定 harness contract vs product composition」的實體套件邊界、公開 API 治理、依賴方向強制與 semver 政策**——這正是 X26「Separate the reusable harness contracts and framework-neutral primitives from Chat Gun product composition without moving product policy into the library or creating behavior drift」的缺口。

## 解決方案

以「契約優先 + 兩 repo 分權 + adapter 消費」收斂，不重造 X11–X21 的 runtime：

1. **契約盤點與分類（ADR）**：對 v4 契約做唯讀盤點，依五類分類——`stable public contract`（9 大契約家族的型別/schema）、`reusable internal primitive`（error classification、stable event id、retry/backoff、idempotency key 等純函數原語）、`Chat Gun product contract`（產品政策、UI、provider registry、deployment config）、`infrastructure adapter`（Postgres/Redis/MCP/LangGraph 綁定）、`experimental`（未達穩定語意）。分類結果寫成 design 的 ADM，並在 implementation 完成後 promote 為 `docs/decisions/` 正式 ADR。

2. **三個 npm 套件與依賴方向**：`@gun-ai/harness-contracts`（純型別/schema，無 product/framework 依賴，僅以 Zod v3 作為 schema validation 的 runtime dependency）、`@gun-ai/harness-kernel`（無框架依賴的 deterministic primitives，依賴 contracts）、`@gun-ai/harness-testkit`（deterministic clock/ID、fixture builder、failure injection 基礎，依賴 contracts+kernel）。方向固定 `contracts ← kernel ← testkit`，三者都不得 import React、LangChain、Express、DB client、model SDK 或 chat-gun application module。

3. **實體歸屬獨立 `gun-harness` repo + npm 發布**：`@gun-ai/harness-*` 套件原始碼與 CI/publish 位於獨立 `gun-harness` repo；`chat-gun` 只透過 `node_modules`（npm published version 或開發期 `file:`/`link:` 指到本地 checkout）消費。本 Change 在 `chat-gun` 端交付「契約 spec（作為兩 repo 的 contract of record）+ consumer-side refactor + 邊界/版本/回滾強制」。

4. **一次抽一契約家族、立即 adapt**：依「一次移動一個 contract family、chat-gun 立即改為 adapter 消費、不維持長期重複定義」的原則，把 9 大契約家族的型別/schema 抽進 `contracts`，純函數原語抽進 `kernel`，deterministic testkit 抽進 `testkit`。Chat Gun 的 product 政策與 concrete adapter 留在 `chat-gun` 並以 DI composition root 綁定。

5. **公開 API 治理**：`@gun-ai/harness-*` 的符號預設不輸出，只 export 有 external use case 的符號；公開符號有文件、API-surface snapshot 與 semver/changelog 政策；serialized envelope 有 explicit versioning 與 unsupported-version typed failure——此 versioning **沿用既有 `version-compatibility.ts` 的 `RuntimeVersionSet`／`evaluateRuntimeVersionCompatibility`**，不新建平行機制。套件於 X26 發布 public alpha；完整 provenance/signing 治理屬 X29。

6. **依賴方向與邊界強制**：新增 automated boundary/cycle check（沿用並強化既有 `operations/architecture-checks.ts` 模式），阻止 `@gun-ai/harness-*` 反向依賴，阻止 chat-gun 保有平行本地定義。

## 受影響範圍

### 受影響套件

- `backend`（主要）：`backend/src/runtime/` 的 9 大契約家族型別與純函數原語抽進 `@gun-ai/harness-*`；`backend` 移除平行本地定義、改由 adapter 消費；`runtime/index.ts`、`execution-context/`、`retry/error-classification.ts`、`events.ts`、`event-envelope.ts`、`event-sequence.ts`、`side-effect/`、`idempotency/`、`authorization/`、`persistence/rows.ts`（checkpoint/resume token）等改為 re-export 或 adapter 包裝。
- `bff`：預設不改；bff 若需錯誤碼/事件型別做 error mapping，應改 import `@gun-ai/harness-contracts`，不得複製後端型別（列為規格疑問收斂）。
- `frontend`：不改；frontend 有獨立型別（`frontend/src/types/tools.ts`），不得直接依賴 `@gun-ai/harness-*` 的 authority-critical path。
- `gun-harness`（獨立 repo，非本 git tree）：`@gun-ai/harness-contracts`、`@gun-ai/harness-kernel`、`@gun-ai/harness-testkit` 的實作、CI、publish；以本 Change 的 delta spec 為 contract of record。

### 受影響能力域

- execution identity／`ExecutionContext`（X20/X22，抽 `contracts`）。
- task/step/run lifecycle（X11 task-step-state-machine）。
- tool descriptor／invocation envelope（X14 unified dispatch）。
- authorization decision/result types（X13）。
- failure taxonomy（X15 provider-tool-call-decoding、X16 scheduling-resilience）。
- event envelope（X19 runtime-event-contract）。
- checkpoint/resume token（X20 durable-hitl）。
- side-effect/idempotency record（X14 side-effect-tool-execution-runtime）。
- approval／terminal outcome（X20 durable-hitl + X19 terminal state）。

### 既有能力原語（本 Change 接線、不重造）

- `backend/src/runtime/types.ts`、`state-machine.ts`、`run-status.ts`（lifecycle 型別）。
- `backend/src/runtime/execution-context/execution-context.ts`（identity schema）。
- `backend/src/runtime/retry/error-classification.ts`（failure taxonomy）。
- `backend/src/runtime/events.ts`、`event-envelope.ts`、`event-sequence.ts`（event envelope）。
- `backend/src/runtime/side-effect/`、`idempotency/`（side-effect/idempotency record）。
- `backend/src/runtime/authorization/`（authorization decision/result）。
- `operations/architecture-checks.ts`（邊界檢查，本 Change 強化）。

## 目標

- 一份 reviewed inventory 把每個 candidate contract 分類到單一 owning repository/package。
- `contracts`／`kernel`／`testkit` 有文件化的依賴規則與自動化 cycle/boundary check。
- `chat-gun` 透過 adapter 消費抽出的契約，不再保有平行本地定義。
- 穩定 serialized contract 有 version，且含 unsupported-version typed 行為。
- 公開 export 是有意、有文件、有 API-surface test；預設 private。
- 抽出的套件不依賴 chat-gun、UI framework、model SDK、concrete persistence client。
- error identity 與 causal metadata 跨越套件邊界後仍保留，且不洩漏 secret。
- 有回滾計畫可讓 `chat-gun` 回到前一 package version 而不失去 durable-state 相容性。

## 非目標

- ❌ 不把整個 Chat Gun runtime 一次性移進 library。
- ❌ 不發布 product-specific repository、schema、UI type 或 provider credential。
- ❌ 不複製契約後讓 chat-gun 與 gun-harness 各自 drift（不得維持長期重複定義）。
- ❌ 不把每個 internal TS type 都當 public API。
- ❌ 不把 product authorization policy 編進 reusable kernel。
- ❌ 本 Change 不做 X27 的 SDK/manifest、X28 的 LangGraph/ChatGun adapter、X29 的 conformance/compatibility matrix（各自獨立 Change）。
- ❌ 不建立第二個 runtime、第二條 authorization 路徑或 UI-only 的 durable state 近似。

## 風險

- **跨 repo 抽取造成行為 drift**：抽出後若 chat-gun 與 gun-harness 各自保有定義，會違反 invariant #6。緩解：一次抽一契約家族並立即 adapt；以 boundary check 阻止平行本地定義；delta spec 為 contract of record。
- **抽取破壞 build/test**：大量 import 改寫易造成 backend build 中斷。緩解：tasks 拆成可獨立驗證增量，每批皆通過 `lint/test/build`；先立 `contracts`（純型別，無 product/framework 依賴，僅 Zod v3）再抽 kernel/testkit。
- **循環依賴**：contracts/kernel/testkit 之間或與 product 之間形成 cycle。緩解：方向固定 `contracts ← kernel ← testkit`，automated cycle check 阻斷。
- **consumption bootstrap（套件尚未發布時）**：chat-gun 改為 registry 版本消費前，`@gun-ai/harness-*` 必須先於獨立 repo 建立並由 Human 發布 public alpha；未發布時不得假稱 portable install 完成。現況：三套件 public `0.1.0-alpha.1` 已發布且可匿名取得，本 Change 的剩餘工作為核實發布證據，並從包含實作與本 OpenSpec change 的已提交本地 SHA 完成同修訂 clean-clone 驗收。
- **公開 API 過度暴露**：把 internal type 誤當 public API 會鎖死未來重構。緩解：預設 private，只 export 有 external use case 的符號；API-surface snapshot 鎖定。
- **秘密跨邊界洩漏**：error/causal metadata 跨越套件邊界時可能帶入 credential。緩解：沿用 X25 secret non-leakage 語意，跨邊界 error 只帶 stable code/retry class/correlation，不帶原始 credential。

## 回滾策略

- 每個 task 皆可獨立 revert；抽取以 additive 為先（contracts 純型別不變更 runtime 語意）。
- `chat-gun` 的 consumer refactor 以「import 改寫」為主，回滾即還原為前一 commit 的本地定義；因為抽取前後型別語意相同，durable-state（checkpoint/event/side-effect 序列化格式）不得因搬移而變。
- 若 `@gun-ai/harness-*` 某版本出現不相容，回滾 `chat-gun` 的 dependency 到前一 published version，並由 unsupported-version typed failure 保證不靜默誤讀。
- 不引入不可逆 schema 破壞；serialized envelope 的 version 欄位 additive，未知版本 → typed failure 而非猜測。

## 驗證計畫

- `cd backend && npm run lint && npm run test && npm run build` 全程通過（抽前抽後皆以既有套件驗證命令為準）。
- 新增 boundary/cycle check test：`@gun-ai/harness-*` 反向 import chat-gun/React/LangChain/DB client 的 fixture 皆 fail；production sources 皆 pass。
- 新增 API-surface snapshot test（於 `gun-harness` repo 執行，`chat-gun` 端以 contract spec 覆蓋）。
- 新增 serialized contract versioning test：unknown version → typed compatibility failure；known version → pass。
- 新增 consumer 整合 test：chat-gun 以 adapter 消費 contracts，無平行本地定義（grep/architecture-check 證明）；error identity 跨邊界保留 code/retry class/correlation 且無 secret。
- 回滾 test：downgrade `@gun-ai/harness-*` 後既有 checkpoint/event 仍可讀（durable-state 相容）。
- `gun-harness` repo 的 clean-install、package build/test、pack 與 publish dry-run 須通過；三套件 public `0.1.0-alpha.1` 已發布後，`chat-gun` 以精確 registry 版本消費。最終驗收從包含實作與本 OpenSpec change 的已提交本地 SHA，以 `git clone --no-local` 建立無 sibling `gun-harness` 的獨立 clone，完成 `npm ci`、lint、完整 test、build、`npm ls`（三套件解析自 registry package、lockfile SHA-256 對照、無本機連結）與 boundary／cycle／parallel-definition／API surface／rollback 驗證，並從同一修訂通過 OpenSpec strict 與 `git diff --check`。完整 conformance、provenance/signing 治理留待 X29；未驗證項如實列出。

## 規格疑問（review 後收斂）

1. **consumption 的 bootstrap 順序**：已定案為「開發期 `link:`/`file:` 指到本地 checkout；X26 merge 門檻要求 `@gun-ai/harness-*` public `0.1.0-alpha.1` 已發布且可匿名取得，`chat-gun` 以精確 registry 版本消費；最終驗收從包含實作與本 OpenSpec change 的已提交本地 SHA 建立獨立 clean clone（`git clone --no-local`），不需 remote push，remote push 由 Human 後續執行」。發布由 Human 執行。
2. **bff 是否也改 import `@gun-ai/harness-contracts`**：**留待 apply-change 前由 CCR 再確認** bff 是否實際有跨套件型別依賴；若有，一律改 import `contracts`，不得複製後端型別。
3. **kernel 的首版範圍**：已收斂（design §3.1.1 + T4）＝deterministic、無 I/O、無框架純函式（error classification、stable event id、retry/backoff、idempotency key、hash/dedup key、envelope parse、version-compat、scope predicate）。
4. **package registry 與 scope 授權**：Human 已定案 npm scope 為 `@gun-ai`，三套件名稱為 `@gun-ai/harness-contracts`、`@gun-ai/harness-kernel`、`@gun-ai/harness-testkit`；X26 發布目標為 public `0.1.0-alpha.1`、`alpha` dist-tag。三套件 public `0.1.0-alpha.1` 已由 Human 發布，`backend/package-lock.json` resolved 指向 registry.npmjs.org；尚待核實的發布證據為來源 revision 與 tarball integrity／內容對應、Human 發布授權與公開內容審閱（由 Codex 補證、Human 追認）。Git commit/push 由 Human 後續執行，不作為 X26 驗收前置；不得把「已發布」逕行推定上述證據全部完成。未完成匿名 clean-clone 驗收時不得 archive。X29 仍負責完整 conformance／compatibility matrix／consumer-driven release gate／provenance／signing 治理。
5. **公開 API 的分界**：已收斂（design §3.1.1 三向拆分規則 + §3.4 barrel 判定），判定表進 inventory ADR。
