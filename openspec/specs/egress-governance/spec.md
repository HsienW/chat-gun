# egress-governance Specification

## Purpose

本規格定義集中 egress governance 的正式需求：以 versioned egress policy 取代 per-tool 散落的網路檢查，統一進行 destination normalization 與 policy 評估，抗拒 URL parser disagreement、DNS rebinding、redirect escape、encoded IP 與 private-network traversal，並把 egress decision 寫入 audit evidence。
## Requirements
### Requirement: egress policy MUST 集中且 versioned，取代 per-tool 散落檢查

Backend MUST 定義集中、versioned 的 egress policy（deny-by-default），供 built-in tools、external-process tools、MCP／tool-server adapters 與未來 SDK tools 共用；不得保留 per-tool 散落的網路檢查作為唯一控制。

#### Scenario: built-in tools 一致套用

GIVEN `web_search`、`weather` 與 `web_fetch` 皆需網路存取
WHEN 執行 egress 檢查
THEN 三者 MUST 經同一 egress policy
AND MUST NOT 各自持有不同檢查邏輯

#### Scenario: 未在 policy 允許集合的 destination deny

GIVEN 一個 destination 未在 egress policy 的 allow 集合
WHEN 評估 egress
THEN MUST deny
AND MUST 回傳 typed egress 決策

#### Scenario: 未知 policy 版本被拒絕

GIVEN egress policy 版本為 runtime 不支援的版本
WHEN 載入 policy
THEN MUST 回傳 typed compatibility failure
AND MUST NOT 以預設放行

---

### Requirement: destination normalization 與 policy 評估 MUST 抗拒 parser／DNS／redirect／encoding 繞過

egress policy MUST 抵抗：URL parser disagreement、DNS rebinding、redirect escape、encoded IP、loopback／private-network traversal。

#### Scenario: DNS rebinding 兩段驗證

GIVEN 一個 hostname 於 DNS resolve 階段解析到公網 IP
AND 實際 connect 階段解析到私網 IP
WHEN 執行 egress
THEN MUST 於 connect 階段重新驗證實際 IP
AND MUST deny 若實際 IP 落入私網／loopback

#### Scenario: encoded IP 繞過被拒

GIVEN 一個以 encoded form（decimal／hexadecimal／IPv4-in-IPv6）表達私網 IP 的 destination
WHEN 執行 normalization
THEN MUST 正規化後判定為私網
AND MUST deny

#### Scenario: redirect escape 重評

GIVEN 一個 allowed destination 回應 redirect 至 denied destination
WHEN 處理 redirect
THEN MUST 對 redirect target 重新執行完整 egress policy
AND MUST deny 若 target 不在 allow 集合或落入私網

#### Scenario: localhost 與 private-network traversal 被拒

GIVEN 一個 destination 為 localhost、loopback、link-local、RFC 1918 private IPv4 或 unique-local IPv6
WHEN 執行 egress
THEN MUST deny
AND MUST NOT 以 string-prefix 檢查即放行

---

### Requirement: egress policy MUST 對所有 destination 執行 deny-by-default，且不建立全域無限制 allowlist

egress policy MUST 採 deny-by-default；任何未明列允許的 destination MUST 被拒。MUST NOT 建立所有 tools 共用的全域無限制網路 allowlist。

#### Scenario: 無全域 allowlist

GIVEN 兩個不同 tool 的 egress 需求不同
WHEN 評估 egress
THEN MUST 依各自宣告的 egress requirement 評估
AND MUST NOT 存在一個共享的全域無限制 allowlist

#### Scenario: 未宣告 egress requirement 的 tool deny

GIVEN 一個 tool 未宣告任何 egress requirement
WHEN 嘗試網路存取
THEN MUST deny
AND MUST NOT 獲得隱含網路權限

---

### Requirement: redirect 與 secondary connection MUST 依同一 policy 重評

任何 redirect 目標與 secondary connection MUST 依同一 egress policy 重新評估，不得沿用首次評估的放行結論。

#### Scenario: secondary connection 重評

GIVEN 一次執行建立 secondary connection
WHEN 評估該 secondary connection
THEN MUST 依同一 egress policy 重新評估
AND MUST 不沿用首次 destination 的 allow 結論

#### Scenario: 多次 redirect 皆重評

GIVEN 一連串 redirect
WHEN 依循 redirect
THEN 每一次 hop MUST 重新評估
AND 任一跳 deny MUST 終止後續網路存取

---

### Requirement: egress decision MUST 寫入 audit evidence

每次 egress 評估的 decision（allow／deny 與 reason）MUST 寫入 audit evidence，並可對應 run／task／step／principal／tool-call identity。

#### Scenario: deny 亦留 evidence

GIVEN 一次 egress 評估被 deny
WHEN 查詢 audit evidence
THEN MUST 記錄 deny decision 與 reason
AND MUST 可對應 tool-call identity

#### Scenario: egress policy 無法執行時 fail closed

GIVEN egress policy 模組無法載入或評估失敗
WHEN 執行需要網路存取的 tool
THEN MUST fail closed
AND MUST NOT 於 policy 不可用時放行網路存取

### Requirement: egress 失敗 MUST 保留有型別的原因分類

每次 egress 評估的結果 MUST 帶有屬於單一來源封閉集合的 reason。每個 reason MUST 固定歸屬於「deny」（policy 判定不允許）或「unavailable」（policy 無法完成評估或出站基礎設施失敗）其中之一。任何消費 egress 結果的元件 MUST 保留原分類與 reason，MUST NOT 將 unavailable 改報為 deny，或將 deny 改報為 unavailable。對外可觀測的錯誤、audit 與事件 MUST NOT 包含目的 URL、解析出的 IP、proxy 位址或憑證。

本 Change 的 tool.invoke audit evidence 要求適用於 execution-profile enforcement 已啟用且已建立 execution evidence 的受治理工具執行。enforcement 停用時，不要求 tool.invoke audit 或 tool result envelope 含 egressDecision；policy 的原分類、fail-closed 行為，以及 knowledge 錯誤、knowledge.model.usage、kb_search 與 shopping lookup_failed audit 的 reason 傳遞要求 MUST 保持不變。受目前 envelope 合約限制，unavailable 的 egressDecision 可為 null，原錯誤分類 MUST 由 outcome 或 tool 的 typed failure 保留，MUST NOT 改報 deny。ledger 在本 Change 只要求能解析既有 unavailable 與未知 reason，不保證保存執行期決策，read-only tool 不要求建立 side-effect ledger 記錄；執行期寫回列後續 Change。

#### Scenario: policy deny 保留 reason

GIVEN 一個目的地不在 policy 允許集合
WHEN 執行 egress
THEN 結果 MUST 為 deny，reason 為「目的地不允許」
AND 消費端收到的錯誤 MUST 仍可辨識為 deny 與該 reason

#### Scenario: DNS 解析失敗不得報為 deny

GIVEN 一個允許的 hostname DNS 解析失敗
WHEN 執行 egress
THEN 結果 MUST 為 unavailable，reason 為「DNS 解析失敗」
AND MUST NOT 被任何消費端回報為 deny
AND MUST fail closed，不得放行網路存取
AND 在 execution-profile enforcement 已啟用且已建立 execution evidence 的受治理工具執行中，audit evidence MUST 記錄 unavailable 與該 reason，MUST NOT 保留同一次 egress 先前的 allow 結果

#### Scenario: enforcement 停用時的 DNS 解析失敗

GIVEN execution-profile enforcement 停用
WHEN 允許的 hostname DNS 解析失敗
THEN policy MUST fail closed 並保留 unavailable 與 DNS_RESOLUTION_FAILED，MUST NOT 改報 deny
AND 本 Change 不要求 tool.invoke audit、envelope 或 ledger 提供執行期 egressDecision
AND knowledge 的 typed failure、用量事件與 shopping audit 的要求仍適用

#### Scenario: 解析到非公網位址仍為 deny

GIVEN 一個允許的 hostname 解析出任一非公網位址（含 RFC 1918、`100.64.0.0/10`、`198.18.0.0/15`）
WHEN 執行 egress
THEN 結果 MUST 為 deny，reason 為「非公網位址」
AND MUST NOT 因該範圍常見於 fake-ip 或內部網路而放行

#### Scenario: 未知 reason 值

GIVEN 消費端收到不在其已知集合中的 reason 值
WHEN 解析 egress 結果
THEN MUST 以明確的未知值處理並保留原分類
AND MUST NOT 丟棄或改寫為其他已知 reason

#### Scenario: 取消與逾時不歸入 egress 分類

GIVEN 一個已通過 egress 評估、正在連線或傳輸中的請求
WHEN 上游取消或逾時
THEN MUST 回傳取消或逾時結果
AND MUST NOT 回報為 deny 或 unavailable

#### Scenario: 可觀測面不洩漏目的地細節

GIVEN 一次 egress 失敗
WHEN 檢查產生的錯誤、audit 與事件
THEN MUST 只包含分類與 reason
AND MUST NOT 包含目的 URL、IP、proxy 位址或憑證

