## Context

集中 egress policy（`egress-governance`）的出站流程是：本地 DNS 解析 → 每個位址檢查是否為公網 → pin 第一個位址直連，並在 connect 階段再驗證位址。knowledge 模型閘道經此 policy 呼叫 embedding 與 rerank。

容器診斷（Master 執行）：

- 2026-10-28：容器內 DNS 對 `dashscope.aliyuncs.com` 回傳 `198.18.0.71`、`2001:2::46`（Clash fake-ip），容器內沒有 `*_PROXY` 變數。egress policy 正確拒絕；knowledge 閘道卻把結果報成無原因的 `EGRESS_DENIED`。
- 2026-10-29：改用不發 fake-ip 的線路後，DNS 回傳阿里雲公網 IP，天氣恢復。`kb_search` 改回 `KB_STORE_UNAVAILABLE`；查得容器內 `KNOWLEDGE_DATABASE_URL` 為 `localhost:5434`（來自主機 `.env`）。以 shell 變數改指 `knowledge-postgres:5432` 後，「Tonic Earbuds」回 `evidence_found`（5 筆引用），「快煮壺」回 `no_source_found`（不在語料中，屬正確拒答）。`KNOWLEDGE_DATABASE_URL` 不在任何 `.env.example` 中，屬 Master 個人設定，本 Change 不修改 compose。

已核對的程式位置（HEAD `a0a2198`，供 Implementer 定位，非行為契約）：

| 代號 | 位置 | 現況 |
| --- | --- | --- |
| C1 | `backend/src/knowledge/model-gateway.ts:230` | 任何 `EgressPolicyError` → `EGRESS_DENIED`，`reasonCode` 遺失；message 可能含目的 IP |
| C2 | 同檔 `:181` | 用量事件只有 `errorCode` |
| C3 | `backend/src/runtime/tool-dispatch/egress-policy.ts:322-332` | DNS 失敗為 `EGRESS_POLICY_UNAVAILABLE`／`DNS_RESOLUTION_FAILED`，經 C1 誤報 |
| C4 | 同檔 `:141-160`、`:336` | 任一解析位址非公網即 `PRIVATE_ADDRESS`（含 `198.18/15`） |
| C6 | 同檔 `:36-39` | `EgressDecision.reasonCode` 為無型別 `string` |
| C10 | `backend/src/knowledge/ingestion.ts:9-16` | fatal 清單含 `EGRESS_DENIED`，無 unavailable |

## Goals / Non-Goals

**Goals：**

- egress 失敗的原因在錯誤、audit 與用量事件中保持有型別、可區分，且不洩漏 URL、IP、proxy 位址或憑證。
- 文件讓使用 fake-ip 代理的人能自行排除問題。

**Non-Goals：**

- egress 的部署 proxy 路由（後續 Change）。
- 修改 compose 或 `.env.example`。
- 放寬任何私網範圍、加公網通配、讓 knowledge 繞過 egress policy、把 chat 納入 egress policy。
- 修正 `KB_STORE_UNAVAILABLE` 吞掉原因（後續建議）。
- 改 frontend、BFF。

## Decisions

### D1：`reasonCode` 改為封閉集合

以單一來源常數定義 egress reason，涵蓋既有值：`POLICY_ALLOWED`、`URL_INVALID`、`URL_PARSER_DISAGREEMENT`、`PROTOCOL_NOT_ALLOWED`、`EMBEDDED_CREDENTIAL`、`PORT_NOT_ALLOWED`、`PRIVATE_ADDRESS`、`DESTINATION_NOT_ALLOWED`、`DNS_EMPTY`、`DNS_RESOLUTION_FAILED`、`CONNECT_HOST_MISMATCH`、`TOO_MANY_REDIRECTS`。每個 reason 綁定固定的 `EGRESS_DENIED` 或 `EGRESS_POLICY_UNAVAILABLE` 分類，不得由呼叫端自行組合。消費端遇到未知值 MUST 以 `UNKNOWN` 處理而非丟棄。本次不新增 reason 值。

分類原則：「policy 判定不允許」為 deny；「policy 尚未能判定，但基礎設施（例如 DNS）無法完成」為 unavailable。

替代方案：保留字串、只在 knowledge 端映射 → 否決，會讓 knowledge 自行重新推測 egress 語意（跨層責任漂移）。

### D2：knowledge 保留 egress 分類

模型閘道依 egress 錯誤的 `code` 對應 `EGRESS_DENIED` 或新的 `EGRESS_POLICY_UNAVAILABLE`，並把 `reasonCode` 帶入 `KnowledgeError` 與用量事件的 `egressReasonCode`。`KnowledgeError` 的 message MUST NOT 沿用 egress message（其中可能含 hostname 或 IP），改為只含分類與 reason 的固定文字。`EGRESS_POLICY_UNAVAILABLE` 不列入 retryable（同一 run 的後續呼叫會以相同方式失敗），並加入入庫 fatal 清單。`kb_search` 在 query 端收到兩者都回 typed failure，不降級為空結果，並以可選欄位 `egressReasonCode` 保留 reason；shopping assistant 的 failure schema 同步接受該欄位。rerank 端的 egress 失敗維持 recall-only 降級，`degradation` 以可選欄位 `egressErrorCode`、`egressReasonCode` 保留原分類與 reason。

audit evidence 的 decision 新增 `unavailable`：policy 無法完成評估時記錄 `unavailable` 與 reason，並覆蓋同一次 egress 先前的 `allow`。`egress_decision` 為 JSONB，無資料遷移。`@gun-ai/harness-contracts` 0.1.0-alpha.3 的 tool result envelope 只接受 allow／deny，因此 Master 於 2026-10-31 決定 unavailable 時 envelope 的 `egressDecision` 寫 `null`，分類由 outcome 的 `errorCode` 保留，完整 decision 與 reason 由 enforcement 啟用時的 audit evidence 記錄；MUST NOT 改報為 deny。ledger 能解析 `unavailable` 與集合外 reason，但目前只保存 dispatch 前的 decision，不保證含執行期結果。合約升版列為後續 Change。

已知限制（2026-10-31 驗證發現，Master 決定列為後續 Change）：

- Compose 未設定 `TOOL_EXECUTION_PROFILE_ENFORCEMENT_ENABLED`，此模式下 tool-governance 不寫入 `egressDecision`，tool result envelope 也沒有此欄位。本 Change 的 audit decision 行為只在 enforcement 啟用時生效；預設部署的 egress reason 見於 `kb_search`、`knowledge.model.usage` 與 shopping audit，其他 tool 的 audit 只有 `errorCode`。
- 執行期產生的 decision 不會寫回 ledger；read-only tool 也不經過 side-effect ledger。

### D3：文件

README 新增疑難排解：

- 使用 Clash、sing-box、Surge 等 TUN／fake-ip 工具時，容器會解析到 `198.18.0.0/15` 而被 egress policy 拒絕（reason `PRIVATE_ADDRESS`）；需把 `+.aliyuncs.com`、`+.open-meteo.com`、`api.tavily.com` 等 egress 目的地加入 fake-ip 排除清單，或改用不發 fake-ip 的設定。
- 若在 `.env` 為主機開發設定了 `KNOWLEDGE_DATABASE_URL=…localhost…`，該值會進入容器而導致 `KB_STORE_UNAVAILABLE`；容器需使用 `knowledge-postgres:5432`（未設定時 compose 預設即是）。
- 「快煮壺」等不在合成語料中的商品回 `no_source_found` 是正確行為。

替代方案：修改 compose 讓容器連線字串不受 `.env` 影響 → 不採用，範例設定不受影響，屬個人設定問題，以文件說明即可。

## 各套件變更

- **frontend**：無。knowledge 錯誤碼新增值經既有 tool result 透傳，frontend 以既有未知錯誤降級承接（T2.4 只讀確認）。
- **bff**：無。
- **backend**：D1、D2 及相關測試；`backend/src/operations/architecture-checks.ts` 的既有檢查 MUST 持續通過。

## 安全與權限分析

- deny-by-default、hostname 清單、私網判定與 redirect 重評全部不變；本 Change 只讓失敗原因正確可見。
- 新增的錯誤 message 與事件欄位 MUST 不含 URL、IP、proxy 位址或憑證，降低既有 message 洩漏目的 IP 的風險。
- README 不得包含 Secret、真實帳密或私人網路資訊。

## 資料流

```text
kb_search / ingestion
  → knowledge model gateway
    → egress policy（protocol/credential/port/host/destination → DNS → 公網位址檢查 → connect 再驗證）
    ← EgressPolicyError{code, reasonCode} 或 Response
  ← KnowledgeError{EGRESS_DENIED | EGRESS_POLICY_UNAVAILABLE, egressReasonCode}
  → knowledge.model.usage{errorCode, egressReasonCode}
```

## Risks / Trade-offs

- [使用 fake-ip 的環境仍會失敗] → 屬刻意行為；以 README 與 `PRIVATE_ADDRESS` reason 降低排查成本。
- [weather 的使用者訊息仍不區分原因] → enforcement 啟用時，egress audit 記錄分類與 reason（見 D2 已知限制）；使用者訊息的改善不在本 Change 範圍。
- [README 與 1A-3 衝突] → 實作前先確認 1A-3 狀態，必要時把段落交給該 Change 整合。

## Migration Plan

無資料遷移。回滾為 revert 本 Change 的 commit。

## Open Questions

- 部署 proxy 路由的後續 Change 何時開，視 D5 雲端環境是否需要 proxy 再決定。
