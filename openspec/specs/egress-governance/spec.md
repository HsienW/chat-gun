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
