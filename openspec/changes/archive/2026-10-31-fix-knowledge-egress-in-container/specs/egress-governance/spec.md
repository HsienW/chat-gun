## ADDED Requirements

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
