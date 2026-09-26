# context-assembly Specification

## Purpose
TBD - created by archiving change activate-context-budget-compression-memory. Update Purpose after archive.
## Requirements
### Requirement: 單一 Context item 契約

所有 Agent 產生的模型輸入 MUST 經由一個 shared Context assembly boundary，並把內容依統一 priority 契約映射為 `ContextItem`：system policy／security rules 為 P0、current task 為 P1、active state 為 P2、authorized memory 為 P3、recent messages 為 P4、tool output 為 P5。

#### Scenario: Agent 依 priority 契約組裝
- GIVEN 一個 Agent 擁有 system policy、現行使用者輸入、歷史 messages 與 tool output
- WHEN 呼叫 shared Context assembly boundary
- THEN 產出的 `ContextItem` MUST 各自帶有正確 priority 且來源可追溯
- AND 現行明確輸入（P1）MUST 優先於歷史 Memory（P3）與推論

#### Scenario: 來源型別無法映射
- GIVEN 一個未知的 context 來源型別
- WHEN 組裝器收到該來源
- THEN 組裝器 MUST 回傳明確的 schema／mapping error，MUST NOT 靜默提升或錯置 priority

### Requirement: 硬上限與 P0 不變量

模型輸入 MUST 保持在有效硬上限內。P0 內容 MUST 位於 total hard limit 內。組裝結果的 `exceeded` 為 terminal signal：當壓縮與丟棄後保留內容仍超過有效硬上限時，系統 MUST 回傳明確的 terminal／configuration error 並 MUST NOT 送出超限請求。可丟棄內容的完整丟棄順序為 P5 → P4 → P3 → P2，P0／P1 永不丟棄。

#### Scenario: 正常範圍內
- GIVEN 所有 context 的總 token 在有效硬上限內
- WHEN 組裝器執行 allocate
- THEN 所有 block 依 priority 納入，且無 `exceeded` 標記

#### Scenario: 非 P0 超限
- GIVEN 非 P0 內容使總量超過有效硬上限，但 P0 單獨未超限
- WHEN 組裝器執行壓縮與丟棄
- THEN 系統 MUST 先壓縮 P5／P4，再依 P5 → P4 → P3 → P2 順序整塊丟棄
- AND 最終總量 MUST 不超過有效硬上限
- AND P0 與 P1 MUST 被保留

#### Scenario: P0 單獨超限
- GIVEN P0（system policy／security rules）單獨即超過有效硬上限
- WHEN 組裝器檢查 P0 總量
- THEN 系統 MUST 回傳 `context_p0_overflow` 的 terminal／configuration error
- AND MUST NOT 呼叫模型

#### Scenario: P0＋P1 仍超限
- GIVEN 完整丟棄 P5 → P4 → P3 → P2 後，P0＋P1 仍超過有效硬上限
- WHEN 組裝器計算保留總量
- THEN 系統 MUST 回傳 `context_hard_limit_overflow` 的 terminal／configuration error
- AND `exceeded` MUST 為 true，MUST NOT 呼叫模型

### Requirement: 先壓縮後丟棄與 deterministic fallback

預算不足時，系統 MUST 先執行已設定的 compression，再依完整順序 P5 → P4 → P3 → P2 丟棄可棄之低優先區塊。壓縮為 lossy truncation 僅作用於 P5／P4；P2／P3 不壓縮、只整塊保留或丟棄。壓縮失敗、逾時或被取消時，系統 MUST 採 deterministic truncation fallback，MUST NOT 採信無效的壓縮輸出。

#### Scenario: 壓縮可容納
- GIVEN 預算不足且存在可壓縮的低優先區塊（P4/P5）
- WHEN 執行 compression（僅 P5／P4 截斷）
- THEN 壓縮後的內容 MUST 通過預算且不丟失 P0/P1
- AND manifest MUST 標記 `compressionAction: "compressed"`

#### Scenario: 壓縮失敗或逾時
- GIVEN compression 拋錯、逾時或被取消
- WHEN 組裝器收到底層錯誤
- THEN 系統 MUST 丟棄該壓縮輸出並改走 deterministic truncation fallback
- AND manifest MUST 標記 `compressionAction: "fallback_truncate"` 與 reason code

#### Scenario: token estimator 不可用
- GIVEN token estimator 不可用
- WHEN 組裝器估算 token
- THEN 系統 MUST 採保守 byte-based estimate
- AND manifest MUST 標記 reason code（estimator unavailable）

### Requirement: 受管 Memory 注入

系統 MUST 只召回已授權、可見、同 tenant／scope 的 Memory，並注入 P3。現行明確輸入 MUST 覆蓋衝突的歷史 Memory。Memory store 不可用或逾時時，系統 MUST 依 policy 降級為「無 Memory 繼續」並 emit degraded event，MUST NOT 阻斷 Agent。

#### Scenario: 授權 Memory 注入
- GIVEN 存在與目前 principal／scope 同 namespace 且已授權的可見 Memory
- WHEN 組裝器執行 recall
- THEN 召回的 Memory MUST 以 P3 注入
- AND 未授權、跨 tenant 或不可見的 Memory MUST NOT 注入

#### Scenario: 現行輸入覆蓋衝突 Memory
- GIVEN 歷史 Memory 與現行明確輸入衝突
- WHEN 組裝
- THEN 現行明確輸入（P1）MUST 優先於歷史 Memory（P3）

#### Scenario: Memory store 不可用
- GIVEN Memory store 不可用或 recall 逾時
- WHEN 組裝器執行 recall
- THEN 系統 MUST 依 policy 以「無 Memory」繼續
- AND MUST emit degraded event（`memory_unavailable`／`memory_timeout`）

### Requirement: Provider／model capability 驅動真實上限

實際 context 上限 MUST 來自 provider／model capability 設定，MUST NOT 在 domain logic 以 model-name substring 分支。有效硬上限 MUST 為 configured budget 與 provider context window（扣除 output reserve）之較小值。output reserve MUST 定義為 `max(configured contextOutputReserveTokens, provider maxOutputTokens)`，來源為 capability 與 runtime config 的單一來源。

#### Scenario: provider window 小於 configured budget
- GIVEN provider context window（扣除 reserve）小於 configured budget
- WHEN 解析有效硬上限
- THEN 有效硬上限 MUST 等於 provider 可用額度

#### Scenario: reserve 不小於 window
- GIVEN output reserve 大於或等於 provider context window
- WHEN 解析有效硬上限
- THEN 系統 MUST fail-closed 回 `context_config_invalid` terminal error

#### Scenario: unknown provider／model
- GIVEN provider／model capability 未知
- WHEN 解析 context window
- THEN 系統 MUST 採保守預設並標記 reason code，MUST NOT 因 model-name 分支改變上限

### Requirement: 終端錯誤傳播

context overflow 的 terminal configuration error MUST 經既有 error envelope 鏈傳播至 frontend；任一 Agent MUST NOT 以不同方式吞掉或改寫該錯誤。

#### Scenario: P0 overflow 傳播
- GIVEN 組裝器回傳 `context_p0_overflow`（或 `context_hard_limit_overflow`）terminal error
- WHEN Agent node 收到該錯誤
- THEN 錯誤 MUST 以 `source: "backend"`、`stage: "context_assembly"` 包成 error envelope
- AND 經 InteractionGovernance 標記 terminal 並 emit terminal event
- AND BFF 透傳、frontend 以既有 error envelope 降級渲染

### Requirement: Redacted Context manifest

每次組裝 MUST 產生一份 redacted Context manifest，內容涵蓋 source reference、priority、estimated tokens、compression action 與 policy version，MUST NOT 包含原始 message、Memory value 或未遮罩 PII。

#### Scenario: manifest 產出與遮罩
- GIVEN 一次成功的組裝
- WHEN 輸出 manifest
- THEN manifest MUST 含 priority、source reference、estimated tokens、compression action、policy version
- AND MUST NOT 含原始 message 內容、完整 Memory value、API key、token 或未遮罩 PII

### Requirement: 所有 Agent 使用 shared boundary

Chatbot、Math、MCP 與 Deep Research MUST 全數改經 shared Context assembly boundary；MUST NOT 使用已標 deprecated 的固定 last-N 或無界 history 組裝。

#### Scenario: 無 Agent 使用 legacy 組裝
- GIVEN 四個生產 Agent
- WHEN 任一 Agent 組裝模型輸入
- THEN 其輸入 MUST 經 shared boundary 產出
- AND 不得呼叫 `buildConversationContext` 的 last-N 或 `[...messages]` 全量組裝

#### Scenario: 無界 history 被排除
- GIVEN 大量歷史 messages 使輸入超限
- WHEN 組裝
- THEN 產出 MUST 有界，且依照 documented 順序壓縮／丟棄

### Requirement: 多語與大型 Tool output 覆蓋

組裝 MUST 對繁體中文、英文、中英混雜、emoji 與大型 Tool output 皆維持可用且不超限。

#### Scenario: 多語與 emoji
- GIVEN 輸入含繁體中文、英文、中英混雜與 emoji
- WHEN 估算與組裝
- THEN token 估算 MUST 保守且有界，內容 MUST 保留使用者語意，MUST NOT 因字形損壞

#### Scenario: 大型 Tool output
- GIVEN 單一 Tool output 極大（如 web_fetch 全文）
- WHEN 組裝
- THEN Tool output（P5）MUST 依壓縮／丟棄順序被截斷或丟棄，且不使總量超限

