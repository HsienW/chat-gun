# Weather Plan Consistency

## Purpose

規範 Planner、補救抽取及澄清續行如何建立一致的天氣 Plan。來源為[歸檔規格](../../changes/archive/2026-07-02-fix-weather-plan-consistency-gate/specs/weather-plan-consistency/spec.md)。本規格沿用 [weather-intent-schema](../weather-intent-schema/spec.md) 的意圖欄位與驗證、[weather-forecast-tool](../weather-forecast-tool/spec.md) 的工具及錯誤契約，以及 [weather-location-resolution](../weather-location-resolution/spec.md) 的地點與 Provider 候選規則。

## Requirements

### Requirement: Weather Plan Consistency Gate

主 Planner 的輸出 MUST 先通過天氣請求的 Runtime Validation，再以純函式 Gate 正規化矛盾的 Plan。Gate MUST 具確定性，且 MUST NOT 執行 I/O、呼叫模型或 Provider，或對符合輸入契約的值擲出例外。Fallback、bounded extraction 與 resume MUST 各自在建構 Plan 時滿足其路徑的一致性條件。地點欄位的語意與 Provider 候選的使用遵循 [Weather 能力專項規則](../../../docs/agent-rules/weather.md)。

#### Scenario: 主 Planner 回傳矛盾的澄清 Plan

- **GIVEN** 主 Planner 回傳 `answerMode = "clarify"`、舊的 `clarification` 與通過 Runtime Validation 的非空 `weather.location`
- **WHEN** 系統正規化 Plan
- **THEN** `answerMode` MUST 成為 `weather`，且 MUST 清除舊的 `clarification`
- **AND** 相同輸入 MUST 產生相同結果，這次正規化 MUST NOT 增加模型或 Provider 呼叫

#### Scenario: Fallback 未取得可用地點

- **GIVEN** 主 Planner 無法完成，且 fallback 判定有天氣意圖但沒有可用地點
- **WHEN** 系統建構 fallback Plan
- **THEN** 初始 Plan MUST 為 `clarify`，直到後續路徑取得符合驗證條件的地點

#### Scenario: Bounded extraction 建構天氣 Plan

- **GIVEN** Bounded extraction 回傳候選天氣請求
- **WHEN** 系統驗證並建構抽取結果
- **THEN** 只有通過該路徑驗證的地點及天氣欄位可產生 `weather` Plan
- **AND** 抽取未取得可用地點時 MUST 維持缺地點的澄清結果

#### Scenario: 澄清後由已確認候選建構 Plan

- **GIVEN** 使用者選定 Provider 候選，或補充條件將候選縮小為一個
- **WHEN** 系統建構 resume Plan
- **THEN** `answerMode` MUST 為 `weather`，且請求 MUST 使用該 Provider 候選並承接澄清前的天氣能力及時間範圍

### Requirement: Non-Weather Query Isolation

Consistency Gate MUST NOT 將主 Planner 正確產出的 `direct`、`research` 或 `calculation` 改為 `weather`。

#### Scenario: 非天氣研究問題維持原意圖

- **GIVEN** 主 Planner 對非天氣問題產出 `answerMode = "research"`，且沒有 `weather` 欄位
- **WHEN** 系統正規化該 Plan
- **THEN** `answerMode` MUST 維持 `research`，且 MUST NOT 因 Gate 觸發 Weather Tool

#### Scenario: 非天氣 Plan 附帶無效天氣欄位

- **GIVEN** 主 Planner 產出 `answerMode = "research"`，且附帶沒有可用地點的 `weather` 欄位
- **WHEN** 系統驗證並正規化該 Plan
- **THEN** `answerMode` MUST 維持 `research`，Gate MUST NOT 將它轉為 `weather`

### Requirement: Provider Capability Compatibility

JSON 型 Planner MUST 依配置的 Provider capability 決定是否要求 native JSON 模式。Native JSON 與 prompt-driven JSON 的回應 MUST 經相同的解析與 Runtime Validation。Gateway 的 capability 拒絕規則沿用 [backend-model-runtime](../backend-model-runtime/spec.md#requirement-provider-capability-enforcement)。

#### Scenario: Provider 支援 native JSON 模式

- **GIVEN** 配置的 Provider 回報 `supportsStructuredOutput = true`
- **WHEN** Planner 建立 JSON 型模型
- **THEN** 模型設定 MUST 包含 `responseFormat = {"type":"json_object"}`，回應 MUST 仍經解析與驗證

#### Scenario: Provider 不支援 native JSON 模式

- **GIVEN** 配置的 Provider 回報 `supportsStructuredOutput = false`
- **WHEN** Planner 建立 JSON 型模型
- **THEN** 模型設定 MUST 省略 `responseFormat`，並由 Prompt 要求僅回傳 JSON
- **AND** 回應 MUST 經相同的解析與驗證

#### Scenario: 直接要求 CCR Gateway 使用不支援的格式

- **GIVEN** 呼叫端直接要求 CCR `anthropic-messages` Gateway 使用 native `responseFormat`
- **WHEN** Gateway 驗證 Provider capability
- **THEN** MUST 依 [Provider Capability Enforcement](../backend-model-runtime/spec.md#requirement-provider-capability-enforcement) 拒絕該選項
