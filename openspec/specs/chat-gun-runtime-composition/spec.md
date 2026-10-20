# chat-gun-runtime-composition Specification

## Purpose
定義 Chat Gun 單一受信 composition root、Graph 與非 Graph 共用的治理路徑及傳輸相容性。私有能力驗收與 production publication 分別管理；正式 runner 尚未就緒時，維持 fail-closed 與發布限制。
## Requirements
### Requirement: 單一受信 composition root

Chat Gun MUST 在單一受信 composition root 組裝 identity、persistence、policy、provider registry、tool registry、sandbox/secret broker、scheduling、event publication 與 usage accounting hooks；Graph 與非 Graph 呼叫 MUST 使用同一權威 runtime 契約。組裝所需服務缺失或版本不相容時 MUST 在接受流量前以 typed failure 拒絕，不得部分開放。

#### Scenario: 完整組裝後啟動
- **WHEN** 全部必要服務與版本相容且完成組裝
- **THEN** Graph 與非 Graph 入口 MUST 取得同一受信服務集合與 runtime 身分規則
- **AND** 不得建立平行的 authorization 或 terminal state owner

#### Scenario: 缺少 sandbox 或 policy
- **WHEN** 組裝所需的 sandbox runner、policy 或 secret broker 缺失
- **THEN** 啟動 MUST 產生可辨識的 typed failure，且不得向流量公開部分 Graph/tool
- **AND** 不得退回無限制 host 執行或放寬 egress

#### Scenario: 服務初始化逾時
- **WHEN** 任一必要依賴在設定的初始化期限內未就緒
- **THEN** composition MUST fail closed，維持原有可用集合，不得發布半成品

#### Scenario: 組裝期間取消
- **WHEN** 啟動或部署工作在組裝期間被取消
- **THEN** 尚未發布的新組裝 MUST 被丟棄，既有執行的受信身分與終態 MUST 不變

### Requirement: Graph tool 經同一受治理執行路徑

Graph tool call MUST 經 canonical schema 驗證及 X14 unified dispatch，並沿用既有 authorization、execution profile、sandbox、secret broker、event 與 side-effect evidence 路徑。Graph state、模型輸出及 provider description MUST NOT 授予、擴大或繞過能力。

#### Scenario: 同一工具在 Graph 與非 Graph 路徑執行
- **WHEN** 相同已註冊工具以相同受信 context 從 Graph 與非 Graph 入口呼叫
- **THEN** 兩者 MUST 使用同一 registry、dispatcher、policy/profile 與 side-effect evidence 語意
- **AND** correlation identity MUST 可追溯到各自的 run/task/step/tool call

#### Scenario: 授權或 schema 拒絕
- **WHEN** Graph 來源的工具請求未通過 canonical input schema、authorization 或 sandbox policy
- **THEN** MUST 在 tool 產生副作用前拒絕，保留對應 typed failure 與 audit
- **AND** provider-facing schema 或 framework hook MUST NOT 覆蓋該決策

#### Scenario: Tool timeout 與取消
- **WHEN** Graph tool 執行逾時或上游取消
- **THEN** MUST 沿用 dispatch 的 timeout/cancellation 與 side-effect reconciliation 語意
- **AND** 不得由 Graph node 隱式重試已提交或不確定的外部效果

### Requirement: 傳輸與呈現維持相容

產品請求/job 的 trusted request identity、取消與期限 MUST 經既有傳輸邊界送至 adapter；版本化事件與 typed failure MUST 保留 correlation、錯誤語意及 terminal 單向收斂。新增 metadata MUST 採向後相容設計，UI 不得從 framework metadata 推測授權。

#### Scenario: 版本化串流通過傳輸邊界
- **WHEN** adapter 發出有 correlation 的合法事件
- **THEN** BFF MUST 依既有規則透傳並保留取消、逾時與錯誤碼
- **AND** frontend MUST 安全呈現等待、恢復、失敗與終態

#### Scenario: 未知欄位或未知事件
- **WHEN** adapter 事件帶有向後相容的新欄位或未知 event type
- **THEN** 消費者 MUST 安全降級，保留已知 correlation 與 terminal state
- **AND** 不得將未知內容當成新的 trusted instruction

#### Scenario: 請求取消與 timeout
- **WHEN** 使用者取消請求或 BFF 的 deadline 到期
- **THEN** 取消/timeout 訊號 MUST 傳至權威執行路徑
- **AND** 已提交外部效果 MUST 依既有 reconciliation policy 保留可辨識狀態

### Requirement: 延期發布維持 fail-closed

在 concrete sandbox runner 尚未就緒的延期期間，composition 能力只能以 deterministic／mock／recorded 證據驗證；production traffic 發布與 `isolated_process` 生產執行 MUST 延後至後續 change（concrete runner 由 `sandbox-execution-runtime` 承接，production publication 由後續 composition-publication change 承接）。`trusted_in_process` 工具 MUST 維持其非隔離語意，不得標示為 sandbox-ready；未就緒能力 MUST NOT 宣告為 true；缺 concrete runner 時 MUST NOT 發布需要 `isolated_process` 的工具或宣稱 sandbox-ready 的 composition。

#### Scenario: 無 runner 的驗證組合不發布
- **WHEN** 以 mock／test double 組裝 composition 供驗證
- **THEN** MUST 僅用於非 serving 的驗證情境
- **AND** MUST NOT 對 production traffic 發布或標示為 production-ready

#### Scenario: trusted_in_process 不冒充 sandbox
- **WHEN** 本地工具採 `trusted_in_process` 執行
- **THEN** 其 capability 宣告 MUST 維持非隔離語意
- **AND** MUST NOT 被描述為 OS 層級 process／filesystem／egress isolation 或 sandbox-ready

#### Scenario: 未就緒能力不宣告
- **WHEN** concrete runner 或 live isolation 尚未驗證
- **THEN** capability／readiness 宣告 MUST 回報未就緒
- **AND** 不得以方法存在或 mock 通過替代實際可強制能力的證據
