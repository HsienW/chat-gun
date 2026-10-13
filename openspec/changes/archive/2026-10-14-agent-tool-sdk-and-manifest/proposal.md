# Proposal：agent-tool-sdk-and-manifest

## 變更摘要

本 Change 對應 `second-stage-plan-en-v5.md` 的 **X27**，屬 Second Stage — Layer 9（Harness Platform）Wave 2 的 Change；前置 X13（trusted-tool-authorization）、X14（unified-tool-dispatch-pipeline 與 side-effect runtime）、X25（sandbox/secret/egress）、X26（harness-* 套件抽取）皆已 archive，其主 spec 已存在 `openspec/specs/`。

目標：在 X26 已建立的 `@gun-ai/harness-contracts`／`@gun-ai/harness-kernel`／`@gun-ai/harness-testkit` 分層之上，新增第四個發布面 **`@gun-ai/harness-sdk`**，提供「小、型別化、safe-by-default」的 Agent 與 Tool 宣告 SDK。SDK consumer 以**版本化 manifest** 宣告 agent／tool／I/O schema／capabilities／side-effect class／idempotency／approval／sandbox-egress／retry-timeout／compensation／compatibility，SDK 解析後一律進入 X14 統一 dispatch、X13 authorization、X25 execution-profile 的既有權威路徑，不建立第二個 runtime、第二條 authorization 路徑或 UI-only 的 durable state 近似。

本 Change 遵守 invariant #6「Extraction must not fork behavior」與 #4「Sandboxing and authorization are independent controls」：SDK 是**宣告面（declaration surface）**，runtime 的 X13/X14/X25 是**強制面（enforcement surface）**；SDK 不得複製強制邏輯，也不得以 hook 改寫 trusted identity、authorization、approval 或 billing 結果。

## 問題描述

以本 Change 建立時已 archive 的主 spec 為 contract of record，盤點出下列缺口（file:line 快照由 apply-change 的 T0 唯讀盤點補足，不在此臆測）：

1. **沒有外部 consumer 可用的安全宣告面**：X14 的 `RuntimeToolDescriptor`、X13 的 authorization composition root、X25 的 `ExecutionProfile`／`SandboxRunnerPort` 是 chat-gun internal 契約。X26 只把「型別/schema」抽進 `contracts`、「純函式原語」抽進 `kernel`，但**沒有提供 safe-by-default 的 SDK 入口**，讓不讀 chat-gun 原始碼的 consumer 能正確、一致地宣告 agent/tool 並安全進入 runtime。

2. **manifest 宣告缺少完整的 runtime 對應**：T0 逐欄盤點確認 stable ID、I/O schema、execution profile 與具體 timeout/retry policy 可對應既有契約；但五種 `sideEffectClass` 不等同於既有唯讀／副作用二分，`requiredCapabilities` 不能混同 authorization actions 與 sandbox capabilities，`approvalPolicyKey` 不是 `requireConfirmation` 布林值，`dataClassification` 尚無 runtime descriptor 欄位，`manifestVersion` 也尚未進入相容性檢查與執行證據。原計畫聲稱十類欄位均已分散在既有 descriptor，與 T0 證據不符。

3. **宣告層無安全預設保證**：X25 在 runtime 有 fail-closed（缺 profile/runner deny），但宣告層仍可寫出「缺 capability 或 sandbox 宣告」的不一致 descriptor；X27 要求「無 implicit unrestricted default」，缺宣告一律 deny。

4. **provider 描述無 canonical 來源**：provider-facing tool description 目前散在 provider adapter，沒有「由 canonical manifest 派生、provider quirks 留 adapter、不得削弱 canonical validation」的單一路徑。

5. **無型別化 context view 與穩定 hook 契約**：SDK consumer 需要只看 capability subset 的 typed context；hook 語意需穩定（明確 ordering、allowed mutations、failure propagation、cancellation），且不得 mutate trusted identity/authorization 結果。

綜合而言，v4/X26 已具備完整的**強制面**，但缺少**宣告面**與**版本化 manifest 契約**——這正是 X27「Provide a small, typed, safe-by-default SDK for defining agents and tools that can enter the authoritative runtime without bypassing identity, authorization, sandbox, lifecycle, or event contracts」的缺口。

## 解決方案

以「宣告面 + 版本化 manifest + 既有強制面」收斂，不重造 X13/X14/X25/X26：

1. **manifest 型別/schema 進 `contracts`**：`agent-tool-manifest` 的型別、Zod schema、enum 與封閉 domain constant 進 `@gun-ai/harness-contracts`，作為版本化的**記憶體內宣告契約**。Zod schema 與註冊時函式不得直接寫入 JSON／checkpoint；只有穩定識別、版本與非敏感 evidence 投影可序列化。T0 對照中的強制欄位經受信 composition root 明確轉換或解析，找不到既有 policy/profile/side-effect 實例時拒絕註冊。未知 `manifestVersion` 沿用 X26 相容性判定的 typed failure，並以 additive 欄位擴充該機制及執行證據。

2. **新套件 `@gun-ai/harness-sdk`**：SDK 入口（`defineAgent`／`defineTool` 等宣告式 builder）、註冊時驗證（duplicate stable ID、incompatible version、invalid schema、missing capability、contradictory metadata 於 serve traffic 前 atomically fail）、provider 描述投影（canonical manifest → provider tool schema）、lifecycle hooks 與 typed context views。依賴 `contracts` + `kernel`；不得 import React、LangChain、Express、DB client、model SDK 或 chat-gun application module。

3. **`@gun-ai/harness-testkit` 擴充 SDK helpers**：deterministic clock/ID、authorization decision、tool outcome、stream fragment、checkpoint、failure injection 的 builder（覆蓋 timeout／cancellation／malformed args／duplicate delivery／authz denial／approval wait／ambiguous commit）。

4. **SDK 解析後一律經 X14 unified dispatch**：SDK 不是第二個 executor；SDK-defined tool 與 built-in tool 走同一 dispatch → authorization → execution-profile → sandbox capability → execution 路徑。SDK 只負責宣告、驗證、投影與解析，強制邏輯仍由 runtime 擁有。

5. **safe-by-default**：缺 authorization action 宣告或 execution profile／egress 宣告 → deny；兩項控制分別由 X13 與 X25 強制，不以單一「capability」欄位替代。未知 class/policy/profile、互相矛盾的 metadata 或無法建立完整註冊交易 → typed failure；provider schema 不得削弱 canonical validation；hooks MUST NOT mutate trusted identity/authorization/approval/billing。

## 受影響範圍

### 受影響套件

- `gun-harness`（獨立 repo，非本 git tree）：新增 `@gun-ai/harness-sdk`；`@gun-ai/harness-contracts` 增加 manifest 型別/schema；`@gun-ai/harness-testkit` 增加 SDK helpers。依賴方向固定 `contracts ← kernel ← sdk`、`contracts + kernel ← testkit`。
- `backend`（主要）：以 chat-gun 為 reference production consumer，透過 composition root 接線 SDK 解析 → X14 dispatch；built-in tools 與 SDK-defined tools 共用同一 dispatch/authz/sandbox/event/side-effect 路徑。不新增平行 dispatcher 或平行 authorization。
- `bff`：T7 必須執行自動化透傳驗證；若 `manifestVersion` 被剝除或誤映射，T7 同步修正 BFF，並通過其 test／build。
- `frontend`：T7 必須執行 parser／render 相容性驗證；若 additive `manifestVersion` 或未知欄位造成失敗，T7 同步修正 frontend，並通過 lint／test／build。兩層的修正都由本 Change 的 Codex Implementer 依各套件 `AGENTS.md` 承接，Qwen 於 review-result 審查。

### 受影響能力域

- agent/tool 宣告（新增 SDK 表面）。
- versioned manifest（新增 contracts 表面）。
- tool dispatch（X14，SDK 解析後進入，不變更 dispatcher）。
- authorization（X13，SDK 宣告 required capabilities/approval policy key，不變更 engine）。
- sandbox/egress（X25，SDK 宣告 execution profile 需求，不變更 enforcement）。
- side-effect/idempotency/compensation（X14，SDK 宣告，不變更 ledger）。
- event/lifecycle（X19，SDK tool 進入後沿用既有 event envelope）。

### 既有能力原語（本 Change 接線、不重造）

- `RuntimeToolDescriptor`（X14 unified-tool-dispatch-pipeline spec）。
- `SideEffectToolDescriptor`（X14 side-effect-tool-execution-runtime spec）。
- `ExecutionProfile`／`SandboxRunnerPort`／`trusted_in_process`・`isolated_process`（X25 tool-execution-profile spec）。
- `ToolRiskRegistry`／`AuthorizationEngine`／`require_confirmation`（X13 trusted-tool-authorization spec）。
- `@gun-ai/harness-contracts`／`kernel`／`testkit`（X26 harness-package-boundary spec）。

## 目標

- 最小 agent 與 tool 可被宣告、驗證、註冊並經 authoritative runtime 執行。
- invalid/incomplete manifest 於 serve traffic 前 atomically fail。
- built-in 與 SDK-defined tool 走同一 dispatch／authorization／sandbox／event／side-effect 路徑。
- provider-specific tool schema 由 canonical manifest 派生且不得削弱 canonical validation。
- public SDK hooks 有文件化 ordering、allowed mutations、failure propagation 與 cancellation。
- manifest 版本參與 compatibility check 與 runtime evidence。
- SDK 文件含 safe examples 與至少一個 intentionally rejected unsafe example。

## 非目標

- ❌ 不在 SDK 內建第二個 tool executor（SDK 只宣告、驗證、投影，dispatch 歸 X14）。
- ❌ SDK hooks 不得 overwrite principal／tenant／authorization／approval／billing identity。
- ❌ provider-specific tool definition 不得成為 canonical manifest。
- ❌ 缺 capability 或 sandbox 宣告時不得給 implicit unrestricted default。
- ❌ 不建立任意 ordering 的 lifecycle middleware。
- ❌ 不把 X28（Chat Gun/LangGraph adapters）、X29（conformance/compatibility matrix）、X36（multi-agent delegation）納入本 Change。
- ❌ 不建立第二個 runtime、第二條 authorization 路徑或 UI-only 的 durable state 近似。

## 風險

- **SDK 與 runtime 行為 drift**：SDK 若複製 X14/X25 強制邏輯，會與 runtime drift。緩解：SDK 只做宣告/驗證/投影，強制面一律歸 runtime；boundary check 阻止 SDK 反向 import chat-gun runtime 強制模組。
- **manifest 欄位與既有 descriptor 重複定義**：十類欄位並非全部有直接對應。緩解：design 逐欄指定宣告、解析器與強制面所有者；`dataClassification` 只作 metadata，不聲稱 X23 治理已生效；`manifestVersion` 僅加 provenance／相容性欄位，不改授權決策。
- **safe-by-default 過嚴導致既有 tool 無法宣告**：缺宣告即 deny 可能誤傷 legacy tool。緩解：提供受審查的 migration/adapter 讓既有 built-in tool 以「最小宣告」升級，但不得以 bypass flag 取代宣告。
- **跨 repo 版本漂移**：`gun-harness` 與 chat-gun 分屬不同 git tree，未發布的 SDK 也無法由 backend 的 registry lockfile 乾淨安裝。緩解：Human 先提交／推送含四套件候選版的 `gun-harness` commit，CI 固定該 SHA 做 Windows／Linux tarball 整合驗證；Human 發布後，backend 才鎖定四個 exact registry version 並重跑乾淨安裝。開發用 `file:`／`link` 設定不得提交；發布前結果只稱 tarball integration，不稱 registry clean install。
- **provider 投影削弱 canonical validation**：provider schema 若允許截斷或轉型，可能弱化 validation。緩解：provider 描述只由 canonical manifest 派生，provider quirks 封在 adapter；canonical validation 於 dispatch 前獨立執行。
- **hook 語意不穩定造成授權漂移**：hook 若可 mutate trusted identity，會破壞 invariant #4。緩解：hook 只讀/只附加，寫入 trusted identity/authorization/approval/billing 的 hook 於型別層禁止，並有 architecture test。

## 回滾策略

- `@gun-ai/harness-sdk` 為新增發布面，`contracts`/`testkit` 的變更採 additive（新增 manifest 型別/schema 不改既有語意）；每 task 可獨立 revert。
- chat-gun 的 SDK 接線以 composition root 為主，回滾即還原 composition root 前一 commit；不變更既有 Graph ID、公開 BFF route 或 error-code 語意。
- manifest 版本欄位 additive；未知版本 → typed failure，不靜默誤讀，可安全 downgrade SDK 至前一 version。
- 不引入不可逆 schema 破壞；`RuntimeToolDescriptor` 與 structured tool result 可增加**選用**的 `manifestVersion` provenance 欄位，既有 built-in tool 不必提供；`ExecutionProfile` 與 side-effect ledger 的既有語意不變。回滾時移除 SDK 接線，舊 consumer 仍可讀取無此欄位的結果。

## 驗證計畫

- `cd backend && npm run lint && npm run test && npm run build` 全程通過。
- 新增 manifest schema test：十類欄位齊全且一致 → pass；缺 capability／sandbox／contradictory side-effect+idempotency → 註冊 atomically fail。
- 新增 SDK 註冊驗證 test：duplicate stable ID、incompatible version、invalid schema、lazy module load failure、dynamic import failure、initialization timeout 皆 typed registration failure，且不殘留 partial tool。
- 新增 provider 投影 test：canonical manifest → provider schema 派生；provider truncation/轉型不得削弱 canonical validation。
- 新增 shared-path test：SDK-defined tool 與 built-in tool 走同一 dispatch/authz/sandbox/event/side-effect（architecture test 阻斷 SDK 自建 executor）。
- 以 `current_weather` 作首個遷移範例：保留原實作與原測試，另由受信 adapter 產生 manifest；在隔離的 legacy／SDK 註冊情境中比較 descriptor、policy、profile、dispatcher 與 structured result，並覆蓋授權拒絕、sandbox 拒絕、逾時及取消。
- BFF 自動化測試確認 `manifestVersion` 有／無兩種 structured result 均正確透傳且不洩露內部資料；frontend 測試確認有／無該欄位及未知欄位均不拋錯，既有狀態渲染與 terminal state 不回退。執行 BFF test／build、frontend lint／test／build；失敗時由對應套件修正並重跑。
- `gun-harness` 候選 commit 由 Human 提供固定 SHA；Windows／Linux CI 從該 SHA 乾淨安裝、check、pack 四套件，在拋棄式 chat-gun checkout 暫時安裝同一批 tarball，驗證 backend／BFF／frontend 與 T6 fixture，記錄 SHA、版本、tarball checksum 與結果。Human 發布後，backend package manifest／lockfile 鎖定四個 exact registry version，再以 `npm ci` 重跑跨層驗證；兩階段證據分開記錄。
- 新增 hook 契約 test：public hook 的 ordering、allowed mutations、failure propagation、cancellation；mutate trusted identity 的 fixture 於型別層/architecture test 阻斷。
- 新增 testkit helper test：timeout／cancellation／malformed args／duplicate delivery／authz denial／approval wait／ambiguous commit 的 deterministic fixture。
- 新增 boundary/cycle check：`@gun-ai/harness-sdk` 反向 import chat-gun/React/LangChain/DB client 的 fixture fail；production sources pass。
- SDK 文件 review：safe examples + 至少一個 intentionally rejected unsafe example。

## 規格疑問（review 後收斂）

1. **SDK 套件名稱與首版範圍**：已定案為新增 `@gun-ai/harness-sdk`；manifest 型別/schema 進 `contracts`，SDK 入口/註冊驗證/投影/hooks/context views 進 `sdk`，testkit 擴充 helpers。首版僅含「宣告、驗證、投影、hooks、context views」，不包含執行。
2. **manifest 與既有 descriptor 的接線權威（T0 後修訂）**：只有 runtime 強制欄位須投影到既有 descriptor／policy／profile；宣告 metadata 不假稱具備強制能力。side-effect class、authorization actions、approval policy key、timeout/retry class 與 compensation 的逐欄轉換及 unsupported 狀態見 design §3.3；缺少受信 resolver 或不一致時 fail-before-traffic。
3. **data classification 首版範圍（T0 後修訂）**：X27 只保留非敏感分類鍵作宣告 metadata，沒有既有 runtime descriptor 對應，也不啟用 logging/retention 強制或 consent 工作流；完整治理屬 X23。spec 將明示此例外。
4. **compensation/reconciliation 首版範圍（T0 後修訂）**：首版只接受 `none` 或有既有 `SideEffectToolDescriptor.reconcile` 的 `reconcile_only`；宣稱可 undo／compensate 而無已註冊 action 一律 reject。X31 的新補償執行仍非本 Change 範圍。
5. **provider 投影的 provider quirk 邊界**：provider-specific 描述由 canonical manifest 派生，quirks 封在 provider adapter；首版以 OpenAI-compatible 與既有 provider 為最小覆蓋，不新增 provider。
6. **`@gun-ai/harness-sdk` 發布門檻**：SDK 實作位於 `gun-harness` repo，實際 publish 由 Human 決定並執行。X27 的 plan review 與固定 SHA tarball 整合驗證不以前置發布為條件；但 chat-gun 若保留 SDK import，未發布四套件並鎖定 exact registry version 前，不得宣稱 backend registry clean install 通過，也不得合併該接線。若 Human 延後發布，維持 PR／readiness gate 未完成，另行協調發行方式；X29 conformance 仍屬後續 Change。
