# X28 私有 adapter 基礎

這些模組僅供 backend 內部使用，不從 runtime barrel 或任何 `@gun-ai/harness-*` 套件發布。不代表已驗證 public portability。

## 權威與欄位

| 欄位 | Owner／來源 | 限制與恢復行為 |
| --- | --- | --- |
| metadata `schemaVersion` | X28 私有 schema | 僅 `1.0.0`；未知版本 park |
| `adapterId` | 受信組裝註冊 | 非空、最多 256 字元；不得用來推導 principal |
| `adapterVersion`、`stateSchemaVersion` | adapter／state owner | SemVer、最多 128 字元；受信支援矩陣精確比對 |
| `executionManifest` | 既有 `ExecutionManifestRef` | 沿用公開 schema；版本字串最多 128 字元，ID 最多 256，config hash 為 64 位 hex；不另存 graph 權威欄位 |
| `runtimeVersions` | 既有 `RuntimeVersionSet` | 每個版本非空、最多 128 字元；沿用 kernel compatibility gate |
| `nativeCheckpointRef` | framework persistence | thread/checkpoint 非空、最多 256；namespace 最多 256、可空；僅 correlation |
| `productIdentityRef` | 受信 runtime | run/task 非空、最多 256；step/positive safe-integer attempt 成對；不取得身分或授權寫入權 |
| checkpoint `state` | 各 Graph 的宣告 schema owner | 寫入與讀取皆檢查 JSON、安全大小／深度、secret 與精確 schema；無缺省或靜默裁切 |

所有新 metadata object 拒絕未知欄位。Runtime version 字串保留既有格式，不強制轉成 SemVer。Metadata 格式版本與資料庫 runtime schema version 是不同欄位；後者仍只由既有 gate 裁定。

## 相容性

共用 gate 依序驗證結構、native/product 身分、既有 manifest、既有 runtime versions、adapter/state 支援矩陣。只有 `compatible` 可繼續；`migratable` 僅表示找到唯一、明確且帶 rollback reference 的 migration，呼叫端必須先遷移再重新檢查。Gate 本身不執行 migration，也不改寫來源。Legacy 必須提供可驗證的 manifest、身分與明確 migration，否則 park。

## 註冊與執行

Registry 驗證版本和全部必要 capability，整批成功才原子發布；失敗、逾時、取消、重複 ID 都保留舊集合。Loader 必須配合 AbortSignal 清理自行持有的資源，registry 不管理 framework client 的生命週期。

Reference adapter 僅轉接受信 host 的 `execute`／`policy`，不匯入 LangGraph、不執行裸 tool、不新增 scheduler、ledger 或 terminal owner。Host 必須從已驗證 context 建立 policy，不得從 request checkpoint 推導授權。`resume` 仍必須由 host 的 durable approval／單次恢復 gate 准入；記憶體中的 active-run 防重不是 durable idempotency。Observation 由 host 驗證並經既有 terminal guard 發布；adapter 不自行提交終態。

私有 `FrameworkInvocation` 必須由受信 host 傳入 `ExecutionContext`。Reference adapter 先驗證 context schema，並核對 checkpoint 的 native thread 與產品 run/task 關聯，再呼叫 host policy 或 executor；checkpoint 及 framework state 不得取代受信身分來源。

## Checkpoint store 邊界

`createAdapterCheckpointBoundary` 注入 store、宣告 state schema、secret scanner、大小與深度限制。Store adapter 的 `append` 必須保留 parent reference，不得覆寫舊 checkpoint；目標 checkpoint ID 必須不同，並由實際 store 原子拒絕重複 ID。Opaque client／framework 物件只能留在 store adapter closure，不能放進 metadata 或 state。

寫入一旦呼叫 store，任何錯誤、逾時或取消皆回報 `indeterminate / reconcile`，不能假設未提交或自動重播。未開始的取消仍是 typed cancellation。部署後讀取未知版本回傳 parked，不能偷偷降級或覆寫舊資料。

## 受信組裝入口

`operations/runtime-composition.ts` 提供 backend 私有 `RuntimeComposition`。受信 host 的 initializer 必須先完成依賴就緒檢查，再返回服務集合、runtime version tuple、既有 canonical execution 設定與 adapter loaders。此 API 不是 HTTP／模型可呼叫的設定入口。

組裝入口沿用既有 `LlmGateway` 作為 provider 選擇入口、X14 dispatch 作為唯一 tool executor，以及既有 `createExecutionCompositionRoot`；不新建 authorization engine、scheduler、terminal owner 或 usage ledger。初始化期間不接受流量，`current()` 為 undefined；成功後才一次發布 immutable snapshot。Graph adapter loaders 與非 Graph canonical execution 使用同一批 identity、dispatch、event 與 usage 服務。

必要服務缺失、未知 runtime versions、空 adapter 集合、adapter 驗證失敗、初始化逾時或取消，均不改變已發布 snapshot。並行部署以 typed busy 拒絕。既有呼叫須持有開始時取得的 snapshot，部署替換不修改其服務身分。服務資源仍由受信 host 管理；initializer／loader 必須配合 AbortSignal 清理未發布資源，且不得在初始化期間執行產品工作。

目前完成組裝入口與既有 canonical executor 的 deterministic integration；尚未把四個 Graph 的 scattered assembly 換成此入口，因此 T2.2 保持部分完成，不以入口測試代替正式接線。

## 尚待驗收

- T1.4 共用 schema/gate 與 T2.1 私有註冊基礎已實作。
- T2.3 已完成私有 deterministic／mock 驗收：reference adapter 與真實 LangGraph node 經同一 `RuntimeComposition` canonical executor 的配對測試，驗證相同 X14 dispatch、X19 event correlation 與一次產品 terminal publication；reference fixture 另涵蓋成功、wait/resume、typed failure、未知版本 park、逾時、取消與終態競態。這些證據不代表四 Graph production composition 接線或 live isolation。
- T3.4 共用持久化邊界已實作，尚未接入正式 LangGraph checkpointer／Agent Server；store 測試不能證明 PostgreSQL／Redis 原子性。
- 四個產品 Graph、既有 recovery entry、BFF、frontend 尚未改接，因此本輪不改變正式流量路徑。
- dispatch 單元測試 fixture 明確注入 `pool: null`，避免環境 DATABASE_URL 觸發正式預設依賴；原錯誤碼斷言未修改。PostgreSQL integration 必須仍以真實資料庫驗證。
- Opik opt-in live smoke 前輪失敗未在本輪重跑；`RUN_OPIK_EVALUATION=false` 僅限定本輪測試程序，不更改持久環境設定，不表示 live 驗收通過。
- T3.1–3.6 的私有 Scenario 對照見 `../../operations/x28-scenario-evidence.md`。`createLangGraphStreamAdapter` 承接同一 X19 producer 的 custom stream，沿用既有 checkpoint／approval／terminal owner；`instrumentLangGraphNode` 將受信 Step／attempt 安裝至 node 與 native retry。最終 review／readiness gate 由 Qwen／CCR 裁定。
