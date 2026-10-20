## ADDED Requirements

### Requirement: Graph 與 runtime 身分有明確映射

LangGraph adapter MUST 將 graph invocation、node 與 checkpoint identity 關聯至受信 request/run/task/step/attempt 身分，保留 native Run/Thread 與產品身分的各自權威來源。Checkpoint ID 或 node 名稱 MUST NOT 充當產品、principal 或 authorization identity。

#### Scenario: Graph invocation 與 node 完成
- **WHEN** 一次 Graph invocation 進入並依序執行多個 node
- **THEN** 每個 node/attempt MUST 可關聯到同一產品 run/task 的明確 step/attempt
- **AND** native run/thread/checkpoint ID MUST 僅作 framework correlation

#### Scenario: 缺少或衝突的受信身分
- **WHEN** Graph entry 缺必要產品身分，或 resume 的 checkpoint 關聯與受信 context 衝突
- **THEN** MUST 以 typed failure 拒絕該 invocation/resume，不得從 checkpoint ID 猜測 principal、tenant 或 run

#### Scenario: Admission 逾時或取消
- **WHEN** Graph entry admission 在 deadline 內未完成或被取消
- **THEN** MUST 不進入 node 執行，且不得建立無法關聯的產品 step 或 terminal

### Requirement: 產品 Run ID 與 native Run correlation 分離

產品 `ExecutionContext.runId` MUST 由受信 admission/composition 邊界建立或從 durable admission binding 恢復，MUST NOT 由 native LangGraph `configurable.run_id` 充當。native `run_id`／`thread_id`／checkpoint ID 僅作 framework correlation，MUST NOT 進入產品 `runId`、authorization 主鍵或 admission lock key。新 invocation MUST 產生獨立產品 `runId` 並寫入 canonical `execution_context`；resume MUST 由持久關聯取回並重新驗證 owner。

#### Scenario: 新 invocation 產生受信產品 runId
- **WHEN** 一次新 Graph invocation 於 admission 邊界建立產品 run
- **THEN** 產品 `runId` MUST 由受信 runtime 產生（非 client hint、非 native `run_id`）並寫入 canonical `execution_context` 與 admission binding
- **AND** native `configurable.run_id` MUST 僅存於非授權 correlation 欄位，不得寫入產品 `runId`

#### Scenario: Resume 由 durable binding 取回 runId
- **WHEN** 一次 resume 以既有 checkpoint 進入
- **THEN** 產品 `runId` MUST 由 durable admission binding（task→graphEntry.initialRunId）取回
- **AND** MUST 重新核對 thread／principal／tenant／scope owner，不得以 native `run_id` 或 checkpoint ID 猜測

#### Scenario: 缺 binding 或身分衝突 park
- **WHEN** resume 的 checkpoint 缺 admission binding、binding 身分衝突或 native correlation 版本不符
- **THEN** MUST 回傳 typed `CHECKPOINT_PARKED`／`incompatible` 並保留原 checkpoint
- **AND** MUST NOT 由 checkpoint ID 或 node 名稱推導 principal／tenant／run

### Requirement: Graph checkpoint 與版本相容性

Graph 可恢復狀態與 adapter metadata MUST 可序列化、版本化並對照既有 runtime compatibility 決策；僅宣告的資料可持久化，opaque framework state MUST 與穩定公共契約隔離。讀取不支援或已損毀的 graph/checkpoint/adapter 版本時 MUST 提供 typed outcome，保留原資料並停止 unsafe resume。

Checkpoint adapter metadata MUST 有單一版本化 schema，由 LangGraph 與其他 framework adapter 共用；欄位 MUST 包含 metadata schema version、穩定 adapter ID、adapter/state schema version、既有 execution manifest 與 runtime version reference、native thread/checkpoint/namespace reference，以及產品 run/task correlation。Node checkpoint 的 step/attempt MUST 成對出現。相容性 MUST 先驗證結構與身分，再使用既有 manifest/runtime gate，最後核對 adapter/state 版本；未知欄位、缺欄位與未知版本 MUST fail closed，不得由各 adapter 自行推斷可恢復性。

`CheckpointAdapterMetadataV1` 在 X28 MUST 維持 backend 私有 schema，引用既有公開 `ExecutionManifestRef` 與 `RuntimeVersionSet`，不得另立平行版本機制或從任何 `@gun-ai/harness-*` 套件 export；提升為公開跨套件契約 MUST 是經 review 的獨立 additive change。

#### Scenario: Metadata 為私有且沿用既有版本機制
- **WHEN** X28 定義並使用 `CheckpointAdapterMetadataV1`
- **THEN** 其 `schemaVersion` 與相容性判斷 MUST 沿用既有 `RuntimeVersionSet`／`evaluateRuntimeVersionCompatibility` 語意，不得另立平行機制
- **AND** execution-level correlation MUST 引用既有 `ExecutionManifestRef`，不複製另一份權威欄位
- **AND** 公開化 review 通過前，該 schema MUST 不從 `@gun-ai/harness-*` export

#### Scenario: 兩個 adapter 共用 metadata schema
- **WHEN** LangGraph 與另一個 framework adapter 各自保存可恢復 checkpoint
- **THEN** 兩者 MUST 使用同一 schema 與相容性判定順序，並能辨識 adapter ID、版本及產品/native correlation
- **AND** 任一 adapter MUST NOT 自行新增另一份權威版本欄位

#### Scenario: Metadata 無效或版本未知
- **WHEN** checkpoint metadata 有未知欄位、缺必要欄位、身分衝突或未知 adapter/state 版本
- **THEN** MUST 回傳 typed unknown/incompatible outcome 並 park resume，保留原 checkpoint
- **AND** 不得以另一 adapter 的寬鬆規則或缺省值放行

#### Scenario: 相容 checkpoint 恢復
- **WHEN** checkpoint 的 graph、state schema、adapter/runtime 版本相容
- **THEN** resume MUST 使用已持久的 task/run 關聯與 checkpoint reference，恢復一次合法執行
- **AND** 不得重放 resume 前已提交的外部效果

#### Scenario: 不可序列化狀態
- **WHEN** Graph 試圖保存執行期物件、secret 或未宣告的不可序列化值
- **THEN** checkpoint MUST 明確失敗，保留既有可讀 checkpoint
- **AND** 不得靜默丟欄位後宣稱保存成功

#### Scenario: 不相容版本或損毀 checkpoint
- **WHEN** 部署後的 resume 遇到不支援版本、缺必要 metadata 或損毀 checkpoint
- **THEN** MUST 回傳 typed compatibility/recovery outcome 並 park 執行
- **AND** 不得改寫舊 checkpoint、建立新副作用或將內部錯誤洩漏給使用者

#### Scenario: Checkpoint store timeout 或取消
- **WHEN** checkpoint read/write 逾時或被取消
- **THEN** MUST 維持可辨識的未完成狀態與重試/人工處置依據
- **AND** 不得把未知持久化結果誤判成可安全重播

### Requirement: Interrupt、approval 與 resume 由受信政策裁定

LangGraph interrupt MUST 只提出 durable wait 請求；既有受信 approval/authorization policy MUST 決定是否等待、允許誰回覆、何時過期及能否 resume。Resume MUST 使用單次有效的 approval reference 並重新核對受信身分、權限與版本。

#### Scenario: 有效 approval 後恢復
- **WHEN** interrupt 已保存可恢復狀態且有權者在期限內提交有效 approval
- **THEN** 執行 MUST 從對應 wait 恢復一次，延續原 task/run 關聯
- **AND** wait 前副作用 MUST 不重複

#### Scenario: 未授權或過期回覆
- **WHEN** 回覆者無權、approval 已消耗或已過期
- **THEN** resume MUST 拒絕並保留可稽核的 wait/denial outcome
- **AND** framework interrupt payload MUST NOT 自行取得 approval authority

#### Scenario: 等待期間取消或逾時
- **WHEN** wait 被取消或超出期限
- **THEN** MUST 依產品政策轉成唯一可辨識的取消/逾時或人工處置狀態
- **AND** 不得在稍後收到舊 approval 時繼續已終止的執行

### Requirement: Stream、retry 與產品終態只收斂一次

Graph/model/tool stream MUST 在單一邊界正規化為既有版本化事件，保留 ordering、event identity 與 correlation。Framework retry MUST 對齊 runtime attempt/idempotency/side-effect evidence；native Run status 與產品 terminal 各依其權威來源，產品 terminal MUST 唯一且單向。

#### Scenario: 串流成功且終止
- **WHEN** Graph、model 與 tool 依序產生事件並正常結束
- **THEN** 投影 MUST 保留各來源 correlation 及 run-scoped sequence，產品 terminal MUST 僅提交一次
- **AND** native Run status 與 checkpoint/Thread status MUST 不被互相推測

#### Scenario: 重複、亂序或中斷串流
- **WHEN** 事件被重播、亂序送達或 stream 在 terminal 前中斷
- **THEN** 消費者 MUST 能以穩定 event identity 去重與 bounded reordering
- **AND** 中斷 MUST 保留 typed recovery outcome，不得偽造成功 terminal

#### Scenario: 框架重試不確定外部提交
- **WHEN** framework retry 遇到已提交或狀態不明的 tool attempt
- **THEN** MUST 由既有 idempotency/ledger 判斷並 reconcile 或等待人工處置
- **AND** 不得重複執行副作用或建立第二個產品 terminal

#### Scenario: 成功與取消競態
- **WHEN** Graph 正常結束與上游取消同時到達
- **THEN** 權威 terminal guard MUST 只接受一個產品 outcome
- **AND** 較晚的 progress/cancel/success MUST 不得讓 terminal 回到 running 或另一 terminal

#### Scenario: Node 例外或步數上限
- **WHEN** Graph 初始化失敗、node 例外或超過 recursion/step limit
- **THEN** MUST 保留可辨識的 typed cause 與 correlation，依產品政策進入失敗或人工處置
- **AND** 不得以 generic success 或無法辨識的錯誤掩蓋根因
