# Spec：agent-tool-manifest

## ADDED Requirements

### Requirement: 每個註冊 tool 的 manifest 具備 stable identifier 與完整十類欄位

每個 SDK 宣告的 tool MUST 具備版本化 manifest：stable `toolId`＋`toolVersion`、`inputSchema`／`outputSchema`、`sideEffectClass`、`requiredCapabilities`、`executionProfile`、`idempotency`、`approvalPolicyKey`、`timeoutRetryClass`、`compensation` 與 `dataClassification`。`requiredCapabilities` 是明示的 authorization actions；`executionProfile` 是獨立的 sandbox/egress 宣告。欄位 MUST 明示，允許經 schema 定義的 `none` 值，但缺 action 或 profile 宣告時 MUST NOT 套用 implicit unrestricted 或 host default。manifest 可含記憶體內 Zod schema，MUST NOT 將整份 manifest 或執行函式序列化到 checkpoint／evidence。

#### Scenario: 完整 manifest 通過驗證

- **GIVEN** 一個具備十類欄位、`toolId`/`toolVersion`/`manifestVersion` 合法的 tool manifest
- **WHEN** 以 runtime schema 解析
- **THEN** MUST 通過並回傳 typed manifest
- **AND** 每個欄位 MUST 有明確型別與語意

#### Scenario: 缺 capability 宣告不得套用 unrestricted default

- **GIVEN** 一個 tool manifest 未宣告 `requiredCapabilities` 或宣告空 action 集合
- **WHEN** 註冊時驗證
- **THEN** MUST fail-closed
- **AND** MUST NOT 以「無限制預設」補齊後放行

#### Scenario: 缺 execution profile 宣告不得套用 host 執行

- **GIVEN** 一個 tool manifest 未宣告 `executionProfile`
- **WHEN** 註冊時驗證
- **THEN** MUST fail-closed
- **AND** MUST NOT 回退 host／in-process 執行

---

### Requirement: manifest 以單一型別表達，強制欄位經明確轉換進入既有契約

manifest MUST 以 `kind: agent | tool` 的單一 discriminated union 表達。強制相關欄位 MUST 由受信 composition root 依已核准的逐欄映射轉成既有 `RuntimeToolDescriptor`／`SideEffectToolDescriptor`、`ToolRiskPolicy`／`AuthorizationPolicy` 與 `ExecutionProfile`；`requiredCapabilities` 與 sandbox profile MUST 維持獨立控制。`dataClassification` 是只供後續能力消費的宣告 metadata，首版無 runtime descriptor 對應且不得宣稱已執行資料治理。未知或無法無損轉換的語意 MUST 拒絕註冊，MUST NOT 另建平行授權、sandbox 或 executor。

#### Scenario: manifest 欄位對應既有契約

- **GIVEN** 一個 manifest 聲明 side-effect class、idempotency、execution profile 與 authorization actions
- **WHEN** 接線至 runtime
- **THEN** 強制相關欄位 MUST 分別投影到既有 descriptor、policy 與 profile
- **AND** `dataClassification` MUST 僅為非強制 metadata，MUST NOT 產生平行決策

#### Scenario: 對照缺口必須 raise 而非另立欄位

- **GIVEN** 一個 manifest 的 side-effect class、action、approval、policy class 或 compensation 無已核准轉換
- **WHEN** 受信 composition root 註冊該 tool
- **THEN** MUST 回傳 typed unsupported／incompatible registration failure
- **AND** MUST NOT 以 risk tier、布林預設或新平行欄位猜測其語意

#### Scenario: custom side-effect class 在首版拒絕

- **GIVEN** 一個 manifest 宣告 `sideEffectClass=custom`
- **WHEN** 註冊該 tool
- **THEN** MUST 回傳 typed unsupported registration failure
- **AND** MUST NOT 以唯讀或一般 mutation 預設放行

#### Scenario: classification 不能冒充治理強制

- **GIVEN** 一個 manifest 含 namespaced `dataClassification` key
- **WHEN** 註冊及執行 tool
- **THEN** key MAY 作非敏感 evidence metadata
- **AND** MUST NOT 因該 key 存在就宣稱 retention、consent 或遮罩已生效

---

### Requirement: manifest 具備 explicit schema version 且未知版本 typed failure

manifest MUST 具備 explicit `manifestVersion`；既有 X26 runtime version compatibility contract MUST 以 additive 選用欄位納入該版本，未知或不支援的版本 MUST 回傳 typed compatibility failure。SDK-defined tool 的既有 descriptor、structured result 與 audit evidence MUST 有 additive provenance；既有無 manifest 的 built-in tool 不受影響。

#### Scenario: 未知 manifestVersion 被拒絕

- **GIVEN** 一個 manifest 的 `manifestVersion` 為 runtime 不支援的版本
- **WHEN** 解析該 manifest
- **THEN** MUST 回傳 typed compatibility failure
- **AND** MUST NOT 靜默降級或補齊後放行

#### Scenario: manifest 版本進入 runtime evidence

- **GIVEN** 一個 tool 以某 `manifestVersion` 註冊並執行
- **WHEN** 查詢其 runtime evidence
- **THEN** MUST 含 `manifestVersion`，且由既有 execution context／correlation 可對應 run／task／step／principal／tool-call identity
- **AND** MUST NOT 序列化 Zod schema、hook、函式或 secret

#### Scenario: built-in tool 的既有 evidence 保持有效

- **GIVEN** 一個未使用 SDK manifest 的既有 built-in tool
- **WHEN** 以既有 runtime 執行並解析 structured result
- **THEN** 缺少選用 `manifestVersion` MUST 保持合法
- **AND** 不得改變既有結果或錯誤碼語意

---

### Requirement: 內部不一致的 manifest 於註冊時 reject

manifest 的 side-effect class、idempotency、approval、timeout/retry 與 compensation 互相矛盾時 MUST 於註冊時 reject。`dataClassification` 只驗證為非空 namespaced metadata key，不參與授權或副作用決策。

#### Scenario: side-effect class 與 idempotency 矛盾 reject

- **GIVEN** 一個 manifest 宣告 `sideEffectClass=read-only` 卻宣告 mutation idempotency contract
- **WHEN** 註冊時驗證
- **THEN** MUST reject 為 typed registration failure
- **AND** MUST NOT 進入 dispatch

#### Scenario: irreversible 宣告無補償而謊稱可補償

- **GIVEN** 一個 manifest 宣告 `sideEffectClass=irreversible` 卻聲稱支援 compensation
- **WHEN** 註冊時驗證
- **THEN** MUST reject
- **AND** MUST NOT 讓 UI 後續據此宣稱可 undo

#### Scenario: approval policy key 無法解析時拒絕

- **GIVEN** 一個 manifest 的 `approvalPolicyKey` 找不到受信 `AuthorizationPolicy.policyId` 綁定，或與有效確認要求衝突
- **WHEN** 註冊該 tool
- **THEN** MUST 回傳 typed registration failure
- **AND** MUST NOT 以 manifest 自行批准或放寬 X13 決策

#### Scenario: 不受支援的 timeout/retry class 拒絕

- **GIVEN** 一個 `timeoutRetryClass` 無法解析為受信 `TimeoutPolicy`／`RetryPolicy`
- **WHEN** 註冊該 tool
- **THEN** MUST 回傳 typed registration failure
- **AND** MUST NOT 套用無限制逾時或重試預設

---

### Requirement: duplicate stable ID 或 incompatible version 於註冊時 reject

同一個 `toolId` 的 duplicate 註冊或 incompatible version 共存 MUST 於註冊時 reject，MUST NOT 覆蓋既有註冊或產生不可預期的 rollout。

#### Scenario: duplicate stable ID reject

- **GIVEN** 一個 `toolId` 已註冊
- **WHEN** 以同一 `toolId` 再次註冊不同實作
- **THEN** MUST reject
- **AND** MUST NOT 覆蓋既有註冊

#### Scenario: incompatible version 共存 reject

- **GIVEN** 一個 `toolId` 的兩個 version 語意不相容
- **WHEN** 同時註冊
- **THEN** MUST reject 或走 explicit 相容判定
- **AND** MUST NOT 靜默選取其一
