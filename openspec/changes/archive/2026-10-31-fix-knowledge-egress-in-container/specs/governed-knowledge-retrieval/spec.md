## MODIFIED Requirements

### Requirement: embedding 與 rerank 只經受治理的模型閘道呼叫

embedding 與 rerank 呼叫 MUST 經由模型閘道，以宣告的 capability 判定是否支援。供應商憑證 MUST 只在執行邊界經 secret broker 解析，MUST NOT 由 tool、graph 節點或入庫程序直接讀取。外連目的地 MUST 經 egress policy 判定，含 redirect。egress 失敗 MUST 保留 egress 的原分類：policy 拒絕回報 `EGRESS_DENIED`，policy 無法完成評估或出站基礎設施失敗回報 `EGRESS_POLICY_UNAVAILABLE`，兩者都 MUST 附 egress reason。每次呼叫 MUST 發出可供後續計量消費的用量事件；egress 失敗時事件 MUST 含 egress reason，且 MUST NOT 含 URL、IP、proxy 位址或憑證。既有 chat 用途的行為 MUST 不變。

#### Scenario: 成功嵌入並發出用量事件

- **GIVEN** 已設定支援 embedding 的模型與可解析的 secret reference
- **WHEN** 入庫或查詢請求 embedding
- **THEN** 閘道 MUST 回傳向量
- **AND** MUST 發出含 provider、model、purpose、用量、延遲、結果與 correlation 識別的用量事件

#### Scenario: 未宣告能力的 provider

- **GIVEN** 一個未宣告 embedding 或 rerank 能力的 provider 設定
- **WHEN** 以該用途呼叫
- **THEN** 閘道 MUST 回傳 typed unsupported failure
- **AND** MUST NOT 發出外部請求

#### Scenario: 憑證不可解析或 egress 被拒

- **GIVEN** secret reference 無法解析，或目的地不在 egress 允許清單，或目的地解析為非公網位址
- **WHEN** 請求 embedding 或 rerank
- **THEN** 閘道 MUST 回傳對應的 typed failure；egress 被拒時為 `EGRESS_DENIED` 並附 egress reason
- **AND** MUST NOT 以環境變數或其他路徑取得憑證

#### Scenario: egress 無法完成評估

- **GIVEN** embedding 端點的 DNS 解析失敗
- **WHEN** 請求 embedding 或 rerank
- **THEN** 閘道 MUST 回傳 `EGRESS_POLICY_UNAVAILABLE` 並附 egress reason
- **AND** MUST NOT 回報為 `EGRESS_DENIED`
- **AND** 用量事件 MUST 為失敗並含相同 egress reason

#### Scenario: 查詢端 embedding 遇到 egress 失敗

- **GIVEN** `kb_search` 的 query embedding 回傳 `EGRESS_DENIED` 或 `EGRESS_POLICY_UNAVAILABLE`
- **WHEN** tool 回傳結果
- **THEN** 結果 MUST 為 typed failure，含原錯誤碼與 egress reason
- **AND** MUST NOT 降級為空結果

#### Scenario: rerank 遇到 egress 失敗

- **GIVEN** query embedding 成功，rerank 回傳 `EGRESS_DENIED` 或 `EGRESS_POLICY_UNAVAILABLE`
- **WHEN** `kb_search` 完成檢索
- **THEN** 結果 MUST 以 recall-only 完成
- **AND** 檢索證據的降級資訊 MUST 含原 egress 分類與 reason

#### Scenario: 入庫遇到 egress 失敗即結束 run

- **GIVEN** 入庫進行中，embedding 回傳 `EGRESS_DENIED` 或 `EGRESS_POLICY_UNAVAILABLE`
- **WHEN** 入庫處理該失敗
- **THEN** ingestion run MUST 立即結束為未完成並記錄該 typed 原因
- **AND** MUST NOT 對剩餘文件重複發出相同失敗的外部請求

#### Scenario: 供應商逾時或限流

- **GIVEN** 供應商逾時或回傳限流
- **WHEN** 呼叫 embedding
- **THEN** 閘道 MUST 依既有 resilience policy 退避或回傳 typed failure
- **AND** MUST NOT 無上限重試

#### Scenario: 呼叫被取消

- **GIVEN** 一個進行中的 embedding 或 rerank 呼叫
- **WHEN** 上游請求被取消
- **THEN** 閘道 MUST 中止該呼叫並回傳取消結果
- **AND** MUST NOT 將取消回報為成功或一般錯誤

#### Scenario: 既有 chat 用途不受影響

- **GIVEN** 新增 embedding 與 rerank 用途
- **WHEN** 執行既有 chat、math、research、vision 與 tool 用途
- **THEN** 其行為與設定 MUST 與變更前一致
