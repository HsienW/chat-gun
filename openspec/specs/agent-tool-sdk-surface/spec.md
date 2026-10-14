# agent-tool-sdk-surface Specification

## Purpose
TBD - created by archiving change agent-tool-sdk-and-manifest. Update Purpose after archive.
## Requirements
### Requirement: SDK 提供 safe-by-default 的 agent/tool 宣告入口

`@gun-ai/harness-sdk` MUST 提供 `defineAgent`／`defineTool` 等宣告式 builder，供 consumer 宣告 agent、tool、I/O schema、authorization actions、side-effect class、idempotency、approval、獨立的 sandbox/egress profile、retry/timeout、compensation 與 compatibility。builder 產生記憶體內可驗證的宣告；`defineAgent` 只保存 agent metadata／tool references，不建立另一個 graph。缺 action 或 profile 宣告的宣告 MUST 於型別層不完整，並於註冊時 deny，MUST NOT 給 implicit unrestricted 或 host default。

#### Scenario: 最小 tool 可宣告

- **GIVEN** SDK consumer 以 `defineTool` 宣告一個具備完整 manifest 的最小 tool
- **WHEN** 執行註冊
- **THEN** MUST 產生可驗證的 `ToolManifest`
- **AND** 可經既有 runtime 執行

#### Scenario: 缺 capability 的宣告不完整

- **GIVEN** SDK consumer 以 `defineTool` 宣告 tool 但未提供 `requiredCapabilities`
- **WHEN** 型別檢查或註冊
- **THEN** MUST 不完整並於註冊時 deny
- **AND** MUST NOT 套用無限制預設

#### Scenario: 缺 sandbox/egress 宣告不完整

- **GIVEN** SDK consumer 宣告一個非 `read-only` tool 但未提供 `executionProfile`
- **WHEN** 型別檢查或註冊
- **THEN** MUST 不完整並於註冊時 deny
- **AND** MUST NOT 回退 host 執行

#### Scenario: authorization 與 sandbox 宣告保持獨立

- **GIVEN** 一個 tool 已宣告合法的 authorization action，但缺少 execution profile／egress 宣告
- **WHEN** 註冊該 tool
- **THEN** MUST 拒絕註冊
- **AND** MUST NOT 將 action 視為 sandbox 權限

---

### Requirement: SDK 解析後一律經 X14 unified dispatch，SDK 不是第二個 executor

SDK 只負責宣告、驗證、投影與 typed registration plan；受信 composition root MUST 將 plan 解析為既有 descriptor、policy 與 profile 後進入 X14 unified dispatch。SDK MUST NOT 持有 production registry 或內建第二個 tool executor，SDK-defined tool MUST NOT 直接 invoke 受保護 tool。

#### Scenario: SDK-defined tool 經同一 dispatcher

- **GIVEN** 一個 SDK-defined tool 進入 runtime
- **WHEN** 執行 tool 呼叫
- **THEN** MUST 經 X14 unified dispatcher
- **AND** MUST NOT 由 SDK 自行執行

#### Scenario: SDK 自建 executor 被阻斷

- **GIVEN** SDK 內含一個可自行執行 tool 的 executor 路徑
- **WHEN** 執行 architecture test
- **THEN** MUST fail
- **AND** 該 executor MUST NOT 存在於 SDK 產出

---

### Requirement: public lifecycle hooks 有文件化 ordering、allowed mutations、failure 與 cancellation 語意

SDK 提供的 public hooks（例如 `onBeforeRegister`／`onValidate`／`onProject`）MUST 具備文件化 ordering、allowed mutations、failure propagation 與 cancellation 語意。hooks MUST NOT overwrite principal、tenant、authorization、approval 或 billing identity；任意 ordering 的 middleware MUST NOT 提供。

#### Scenario: hook 不得 mutate trusted identity

- **GIVEN** 一個 SDK hook 嘗試改寫 principal／tenant／authorization／approval／billing 欄位
- **WHEN** 型別檢查或 architecture test
- **THEN** MUST 被阻斷
- **AND** MUST NOT 影響 runtime 決策

#### Scenario: hook 失敗為 typed registration failure

- **GIVEN** 一個 public hook 於註冊時拋錯
- **WHEN** 執行註冊
- **THEN** MUST 回傳 typed registration failure
- **AND** MUST NOT 吞掉錯誤後放行

#### Scenario: 任意 ordering middleware 不提供

- **GIVEN** consumer 要求任意 ordering 的 lifecycle middleware
- **WHEN** 檢查 SDK 表面
- **THEN** MUST NOT 提供該能力
- **AND** 只提供語意穩定的 hooks

---

### Requirement: typed context views 只暴露 capability subset 且不含 secret

SDK consumer MUST 只取得對應明示 authorization actions 的 typed context view；sandbox 實際能力仍由 runtime profile enforcement 決定。view MUST NOT 取得完整 `ExecutionContext`、trusted authorization decision 或 plaintext credential。

#### Scenario: context view 只含宣告 subset

- **GIVEN** 一個 SDK consumer 宣告 capability subset C
- **WHEN** 取得 context view
- **THEN** MUST 只暴露 C 對應的欄位
- **AND** MUST NOT 暴露完整 `ExecutionContext`

#### Scenario: context view 不含 secret

- **GIVEN** 一個 context view 涉及 secret
- **WHEN** 產生 view
- **THEN** MUST 只含 secret reference
- **AND** MUST NOT 含 plaintext credential

---

### Requirement: SDK 文件含 safe examples 與至少一個 intentionally rejected unsafe example

SDK 套件文件 MUST 含 safe examples（最小宣告、註冊、provider 投影、context view），並 MUST 含至少一個 intentionally rejected unsafe example（例如缺 sandbox 宣告、hook mutate identity、SDK 自建 executor），且說明拒絕原因。

#### Scenario: safe examples 存在

- **GIVEN** SDK 文件
- **WHEN** 查閱宣告/註冊/投影/context
- **THEN** MUST 提供 safe example
- **AND** 可照做並經 runtime 執行

#### Scenario: rejected unsafe example 存在並說明原因

- **GIVEN** SDK 文件
- **WHEN** 查閱反例
- **THEN** MUST 含至少一個被刻意拒絕的 unsafe example
- **AND** MUST 說明拒絕原因

