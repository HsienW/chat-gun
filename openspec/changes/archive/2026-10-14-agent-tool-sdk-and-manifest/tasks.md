# Tasks：agent-tool-sdk-and-manifest

> 每個 Task 可獨立驗證；驗證命令以套件現有 script（lint／test／build）為主。SDK 只做宣告／驗證／投影／hooks／context，不建第二個 executor。跨 repo 路徑、版本與 CI gate 依 design §10；未 publish 時不得假稱完成。T0 的唯讀盤點已記錄於 `.agent-runtime/agent-tool-sdk-and-manifest/evidence/t0-manifest-field-mapping.md`，契約缺口經 `review-plan-005` 核准後於 apply-change 驗證。未完成的 live 驗證如實標記。

## T0 盤點與接線對照（唯讀）

> 前置：無。本 Task 必須最先完成，T2–T10 皆引用。

- [x] 對 `backend/src/runtime/`（含 `tool-dispatch/`、`authorization/`、`side-effect/`、`idempotency/`、`retry/`、`execution-context/`）做唯讀盤點，產出「manifest 十類欄位 → 既有 `RuntimeToolDescriptor`／`SideEffectToolDescriptor`／`ExecutionProfile`／`ToolRiskRegistry` 欄位」的逐欄對照表（以符號粒度，非檔案粒度）。
- [x] 標出對照缺口並核對 design §3.3–3.4 的處理：強制欄位有明確轉換或 typed unsupported failure；`dataClassification` 明示 metadata 例外；`manifestVersion` 以 additive provenance 擴充既有契約，不得另立授權／sandbox 語意。
- [x] 確認 built-in tool 的註冊組裝點，標出 SDK-defined tool 接入同一 registry 的位置。
- [x] 對應 `specs/agent-tool-manifest/spec.md`「欄位對應既有契約」與 `specs/sdk-runtime-integration/spec.md`「同一 dispatch 路徑」。

驗證命令：

```bash
# 唯讀盤點，產出對照表（進 design 附錄 / apply 後 promote ADR）
cd backend
npm run build   # 盤點不改 code，確認基線仍綠
```

## T1 契約 delta spec 定稿（contract of record）

> 前置：T0。本 Change 的 3 份 delta spec（agent-tool-manifest / agent-tool-sdk-surface / sdk-runtime-integration）於 review 後定稿為 `gun-harness` 與 `chat-gun` 的 contract of record。

- [x] 依 T0 對照表及 design §3.3 收斂 manifest 十類欄位的型別/schema、`kind: agent | tool` 與公開符號清單；明訂記憶體內 Zod schema 不序列化。
- [x] 收斂 `sdk`（defineAgent/defineTool、validateManifest/registerTool、projectProviderToolDescription、hooks、typed context）與 `testkit`（SDK failure fixtures）首版範圍。
- [x] 明訂 chat-gun 側 composition root 的 staging 組裝／整批發布、受信 policy/profile/class resolver，以及 built-in 與 SDK-defined tool 共用同一 dispatch/authz/sandbox。
- [x] 對應 3 份 delta spec 的範圍條款。

驗證命令：

```bash
# 文件審查：delta spec 與 T0 對照表一致、無遺漏欄位
```

## T2 manifest 型別/schema 進 `contracts`

> 前置：T1。`@gun-ai/harness-contracts` 增加 manifest 型別/schema/enum，採 additive，不改既有型別語意。

- [x] 於 `gun-harness` repo 的 `@gun-ai/harness-contracts` 新增 `AgentManifest`／`ToolManifest` 型別、Zod schema、side-effect class／authorization action／approval reference／policy class／classification key 與 `MANIFEST_SCHEMA_VERSION`；`custom` class 首版 typed reject。
- [x] contracts 只含型別/schema/enum，無 runtime 執行函式、無 `node:*` 依賴（僅 Zod v3）；明確區分不可序列化的 in-memory manifest 與 JSON-safe evidence projection。
- [x] 新增 manifest schema test：十類欄位齊全且一致 → pass；缺 authorization action／sandbox profile、空 action、`custom` class／contradictory metadata → typed fail。
- [x] 對應 `specs/agent-tool-manifest/spec.md`。

驗證命令：

```bash
cd backend
npm run build
# gun-harness repo：contracts clean-install + check + 該 spec 對應測試
```

## T3 建立 `@gun-ai/harness-sdk` 套件與註冊時驗證

> 前置：T2。`gun-harness` 與 chat-gun 使用 design §10 的對應分支；固定 SHA 必須是 Human 提交／推送後含本 Change 的 `gun-harness` 候選 commit。開發期可使用 sibling checkout／本機 tarball smoke，不提交本機路徑；public 發布由 Human 決定。

- [x] 於 `gun-harness` repo 建立 `@gun-ai/harness-sdk`：`defineAgent`／`defineTool` builder、`validateManifest`／`registerTool`，依賴 `contracts`＋`kernel`，無 product/framework 依賴。
- [x] SDK `registerTool` 回傳 typed registration plan；受信 composition root 於 staging 解析 descriptor、authorization policy、profile、tool 後整批發布。duplicate stable ID、incompatible version、invalid schema、missing action/profile、未知 policy/class、side-effect+idempotency 矛盾、lazy module load failure、dynamic import failure、initialization timeout 皆 typed registration failure，不殘留 partial tool。
- [x] 新增 sdk unit test：以上每個 failure 案例皆 typed 且不殘留 partial tool。
- [x] `gun-harness` 四套件記錄同一組 `0.1.0-alpha.2` 候選版及精確依賴；Human 提供含實作的固定 commit SHA 後，跨 repo CI 以 Windows／Linux lane 的四套件 tarball integration 驗證 chat-gun，記錄 SHA、checksum、實際載入版本與結果。不以實作前 base SHA、未提交工作樹或僅本機 link 通過作為完成證據。
- [x] 對應 `specs/agent-tool-sdk-surface/spec.md` 與 `specs/sdk-runtime-integration/spec.md`。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/
npm run build
# gun-harness repo：sdk clean-install + check + test
```

## T4 provider 描述投影（canonical → provider schema）

> 前置：T3。

- [x] `projectProviderToolDescription(manifest, provider)`：由 canonical manifest 派生 provider-facing tool description；provider quirks 封在 provider adapter。
- [x] provider truncation／轉型不得削弱 canonical validation；canonical validation 於 dispatch 前獨立執行。
- [x] 新增 test：canonical → provider schema 派生正確；provider 截斷/轉型不削弱 canonical validation。
- [x] 對應 `specs/sdk-runtime-integration/spec.md`「provider 投影不得削弱 canonical validation」。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/
npm run build
```

## T5 lifecycle hooks 與 typed context views

> 前置：T3。

- [x] 定義 public hooks（`onBeforeRegister`／`onValidate`／`onProject`）的文件化 ordering、allowed mutations、failure propagation、cancellation；hook 只讀/只附加非權威 metadata。
- [x] typed context view：SDK consumer 只取得明示 authorization action subset，不得拿完整 `ExecutionContext` 或 trusted decision；context view 不含 plaintext secret。
- [x] 型別層禁止 hook 寫 trusted identity/authorization/approval/billing；新增 architecture test 阻斷 mutate identity 的 fixture。
- [x] 對應 `specs/agent-tool-sdk-surface/spec.md`。

驗證命令：

```bash
cd backend
npm run lint
npm run test -- src/runtime/
npm run build
```

## T6 擴充 `@gun-ai/harness-testkit` SDK helpers

> 前置：T2、T3。

- [x] 於 `testkit` 新增 deterministic helpers：clock/ID、authorization decision、tool outcome、stream fragment、checkpoint、failure injection（timeout／cancellation／malformed args／duplicate delivery／authz denial／approval wait／ambiguous commit）。
- [x] `testkit` 自身測試與 `backend` 測試消費同一組 SDK registration failure helper，覆蓋「同一 stable ID 重複註冊」及「invalid manifest schema」；保留 `backend/src/runtime/tool-dispatch/runtime-tool-descriptor.test.ts` 全部既有案例與斷言，並在 `backend` 新增平行的手建 fixture／testkit fixture 配對測試。每組在相同 SDK 註冊路徑、相同輸入下的 typed failure code、identity 與 registry snapshot 逐欄相等；前者不得覆蓋原註冊，後者不得留下 partial registry。
- [x] `sdk` 套件測試保留上述兩組等價的本套件案例，以相同輸入與預期 typed failure code、identity、registry snapshot 驗證註冊語意；不得 import 或 devDepend 於 `testkit`。以 boundary/cycle check 驗證依賴方向維持 `testkit → sdk`。
- [x] 對應 `specs/sdk-runtime-integration/spec.md`「testkit 覆蓋 failure interleavings」。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/
npm run build
cd ../../gun-harness
npm run check  # testkit／sdk 測試與 boundary/cycle check
```

## T7 manifest 版本相容性與 runtime evidence

> 前置：T2、T3。

- [x] 對 X26 `RuntimeVersionSet` 加選用 `manifestVersion` 並沿用 `evaluateRuntimeVersionCompatibility`；對 SDK manifest 未知版本 → typed failure，既有 built-in tool 無欄位仍合法。
- [x] 對 `RuntimeToolDescriptor`、structured result 與 audit evidence 加選用 `manifestVersion` provenance；不得保存整份 Zod manifest、hook、函式或 secret。
- [x] 新增 test：known version pass；unknown version → typed failure；SDK 版本可由既有 execution context／correlation 對應 run/task/step/principal/tool-call；legacy result 無欄位仍 pass。
- [x] 本 Change 的 Codex Implementer 負責 BFF 自動化測試：含／不含 `manifestVersion` 的 structured result 與 event 原樣透傳、未知 additive 欄位安全處理、correlation ID／取消／逾時／錯誤碼不改寫；若失敗，依 `bff/AGENTS.md` 修正 BFF 並由 Qwen review。
- [x] 本 Change 的 Codex Implementer 負責 frontend 測試：含／不含 `manifestVersion`、未知欄位及未知狀態的 parser／render 不拋錯，terminal state 不回退；若失敗，依 `frontend/AGENTS.md` 修正 frontend 並由 Qwen review。跨層契約衝突先回到 delta spec 收斂。
- [x] 對應 `specs/agent-tool-manifest/spec.md`「版本參與 compatibility 與 evidence」。

驗證命令：

```bash
cd backend
npm run test -- src/runtime/
npm run build
cd ../bff
npm run test
npm run build
cd ../frontend
npm run lint
npm run test
npm run build
```

## T7a built-in `current_weather` 遷移範例

> 前置：T3、T7。依 design §7.1；只改 `current_weather` 的宣告／註冊接線，保留現有 Weather implementation 與結果語意。

- [x] 在 `backend/src/tools/sdk/current-weather-manifest-adapter.ts` 建立受信 adapter；從既有 descriptor、X13 policy、X25 profile 與 host timeout catalog 明確解析十類欄位。缺 policy/profile/action、版本不相容或 metadata 矛盾須於 serve traffic 前 typed reject，不能注入寬鬆預設。
- [x] 在 `backend/src/tools/registry.ts` 的 staging 組裝中，以 SDK plan **取代** `current_weather` 的 direct descriptor；同一 stable ID 不得雙註冊。文件於 `gun-harness/packages/sdk/README.md` 列出既有 tool → manifest → staging → rollback 的步驟。
- [x] 平行測試隔離的 legacy／SDK 註冊情境：同一 dispatcher factory 與 registry identity，descriptor／policy／profile／egress／timeout／retry 一致；成功、授權拒絕、sandbox 無 runner、逾時、取消與 structured result／audit correlation 一致，SDK 只多 `manifestVersion`。保留並重跑 Weather／Web／Calculator／MCP 回歸。
- [x] 對應 `specs/sdk-runtime-integration/spec.md`「built-in 與 SDK-defined tool 走同一路徑」。

驗證命令：

```bash
cd backend
npm run lint
npm run test
npm run build
```

## T8 擴充 boundary/cycle check

> 前置：T3。

- [x] 擴充 `operations/architecture-checks.ts`：`sdk-forbidden-dependency`（sdk 反向 import chat-gun/React/LangChain/DB client/model SDK）、`sdk-cycle`（contracts/kernel/sdk/testkit 之間 cycle）、`sdk-self-executor`（SDK 自建 executor 或直接 invoke 受保護 tool）。
- [x] 新增 test：forbidden dependency／cycle／self-executor fixture 皆 fail；production sources pass。
- [x] 對應 `specs/sdk-runtime-integration/spec.md`「無第二個 executor」與 `specs/agent-tool-sdk-surface/spec.md`。

驗證命令：

```bash
cd backend
npm run lint
npm run test -- src/operations/
npm run build
```

## T9 SDK 文件（safe + intentionally rejected unsafe examples）

> 前置：T3–T5、T7a、T8。

- [x] `gun-harness/packages/sdk/README.md` 含 safe examples（最小 agent/tool 宣告、註冊、provider 投影、context view）及 `current_weather` 遷移／回滾步驟；範例以受信 host 解析 policy/profile，不示範雙註冊或 bypass。
- [x] 至少一個 intentionally rejected unsafe example（缺 sandbox 宣告、hook mutate identity、SDK 自建 executor），並說明拒絕原因。
- [x] 對應 `specs/agent-tool-sdk-surface/spec.md`「文件含 safe 與 rejected unsafe examples」。

驗證命令：

```bash
# 文件審查：safe examples 與 rejected unsafe examples 皆存在且語意正確
```

## T10 chat-gun 接線與全量驗證

> 前置：T2–T9、T7a。

- [x] 以單一 composition root 接線 SDK 解析 → X14 unified dispatch；built-in 與 SDK-defined tool 走同一 dispatch/authz/sandbox/event/side-effect 路徑，無平行 dispatcher 或平行 authorization。
- [x] 最小 agent/tool 經 SDK 宣告、驗證、註冊並經 authoritative runtime 執行成功。
- [x] 既有 Weather/Web/Calculator/MCP 回歸通過；不變更既有 Graph ID、公開 route、error-code 語意。
- [x] 以 Human 提供、含四套件候選實作的 `gun-harness` SHA，完成 Windows／Linux 的四套件 `npm ci`／check／pack 與 chat-gun 拋棄式 checkout tarball integration；兩 lane 執行相同 T6 fixture 與 backend／BFF／frontend 驗證，保存 SHA、Node/npm 版本、tarball checksum、實際載入來源及測試結果。此為發布前證據，不得稱 registry clean install；交付差異不得含本機 `file:`／`link` 路徑。
- [x] Human 決定並依 `contracts → kernel → sdk → testkit` 發布同版四套件後，將 backend 四個 dependencies／lockfile 鎖至 exact registry `0.1.0-alpha.2`，在 Windows／Linux 乾淨 checkout 以 `npm ci` 重跑 backend lint／test／build 與 BFF／frontend 驗證。SDK-dependent chat-gun 接線在此 gate 通過前不得標記 readiness 完成或合併；Human 延後發布時維持未完成，不以 tarball integration 替代。
- [x] `cd backend && npm run lint && npm run test && npm run build` 全綠；未驗證項（如 live smoke、public alpha 發布）如實標記。
- [x] 對應 3 份 delta spec 全數 Scenario 的覆蓋。

驗證證據：PR #141 的 fixed-SHA tarball CI [run 38406402323](https://github.com/HsienW/chat-gun/actions/runs/38406402323) 在 commit `99fd2e2` 的 Windows／Linux job 全步驟通過，並各上傳 `harness-candidate-*` artifact；workflow 會保存固定的 `gun-harness` SHA、Node/npm 版本、四個 tarball checksum、實際安裝版本／來源與步驟結果。Published-registry CI [run 38399220692](https://github.com/HsienW/chat-gun/actions/runs/38399220692) 的 Windows／Linux job 也通過。Artifact 內容未由本機唯讀 API 下載核對；PostgreSQL、Opik、模型／Provider live smoke 未執行。

驗證命令：

```bash
cd backend
npm run lint
npm run test
npm run build
# 發布前：gun-harness 固定 SHA 的 Windows／Linux CI 執行 npm ci、npm run check 與四套件 pack，chat-gun 暫時安裝 tarball 並重跑上述及 BFF／frontend 驗證
# 發布後：backend exact registry lockfile 的 Windows／Linux 乾淨 checkout 執行 npm ci，再重跑上述及 BFF／frontend 驗證
```
