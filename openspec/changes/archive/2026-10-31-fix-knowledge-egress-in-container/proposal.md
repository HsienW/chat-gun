## Why

X43 的 T10 live 驗證，以及 2026-10-28 Master 在 Docker 環境的實測都發現：容器內的 `kb_search` 回 `EGRESS_DENIED`，商品查詢與政策問答失效；深度研究的天氣工具則回「temporarily unavailable」。排查花了多輪，主因是錯誤沒有保留真正原因。

根因（已於 HEAD `a0a2198` 核對程式，並由 Master 於 2026-10-28／29 的容器診斷確認）：

1. **本機網路環境（不是程式缺陷）**：Master 主機的 Clash 使用 fake-ip。容器內解析 `dashscope.aliyuncs.com` 得到 `198.18.0.71`、`2001:2::46`，容器內沒有任何 `*_PROXY` 變數。chat 直連 fake-ip 後由主機 Clash 透明轉送，所以能通；egress policy 則在連線前把 `198.18.0.0/15` 判為非公網位址而拒絕，這個判定是正確的安全行為。
2. **本機設定（不是程式缺陷）**：Master 個人的 `.env` 把 `KNOWLEDGE_DATABASE_URL` 設成主機開發用的 `localhost:5434`，compose 讓這個值進入容器，導致 `KB_STORE_UNAVAILABLE`。這個變數不在任何 `.env.example` 中，照範例設定的使用者會取得 compose 預設的 `knowledge-postgres:5432`，不受影響。
3. **錯誤分類遺失（程式缺陷，本 Change 修正）**：knowledge 模型閘道把任何 egress policy 錯誤一律改報為 `EGRESS_DENIED`，丟棄 egress 的 `reasonCode`；DNS 解析失敗本為 `EGRESS_POLICY_UNAVAILABLE`，也被誤報為 deny。用量事件只有 `errorCode`，egress 的 `reasonCode` 是無型別字串。

Master 調整本機環境後（不發 fake-ip 的線路、以 shell 變數改正容器連線字串），2026-10-29 人工測試確認商品查詢、天氣與退款審批在容器內皆正常。allowlist 來源單一且正確，不需修改。

## What Changes

- egress 決策的 `reasonCode` 改為有型別的封閉集合，每個 reason 固定歸屬 deny 或 unavailable，並具未知值處理。
- knowledge 新增錯誤碼 `EGRESS_POLICY_UNAVAILABLE`；模型閘道 MUST 保留 egress 錯誤的原分類與 reason，入庫流程將其列為 fatal。
- `knowledge.model.usage` 用量事件新增 `egressReasonCode`，內容 MUST NOT 含 URL、IP、proxy 位址或憑證。
- README 新增疑難排解：fake-ip 類代理工具的排除方式、容器與主機的知識庫連線字串差異、不在語料中的商品回 `no_source_found` 屬正確行為。

## 非目標

- 不把 `198.18.0.0/15`、`100.64.0.0/10` 或任何私網範圍視為可信；不加公網通配；不讓 knowledge 繞過 egress policy。
- 不實作 egress 的部署 proxy 路由（視 D5 雲端環境再開後續 Change）。
- 不修改 compose 或 `.env.example`（範例設定不受影響；本機差異以 README 說明）。
- 不把 chat 納入 egress policy；不修正 `KB_STORE_UNAVAILABLE` 吞掉資料庫錯誤原因（後續建議）。
- 不變更 allowlist 推導方式、embedding space、檢索行為或重試策略。
- 不修改 frontend 與 BFF。

## Capabilities

### New Capabilities

（無）

### Modified Capabilities

- `egress-governance`：ADDED「egress 失敗 MUST 保留有型別的原因分類」。
- `governed-knowledge-retrieval`：MODIFIED「embedding 與 rerank 只經受治理的模型閘道呼叫」，補上 egress 原因分類、`EGRESS_POLICY_UNAVAILABLE` 與入庫 fatal 行為。

## Impact

- **backend**：egress policy 的 reason 型別、knowledge 模型閘道與錯誤碼、入庫 fatal 清單、用量事件；相關測試。
- **既有工具**：`web_search`、`web_fetch`、weather 與地理編碼共用 egress reason 型別；既有分類與 reason 值不變。
- **文件**：README。
- **frontend／bff**：無變更。
- **公開契約**：knowledge 錯誤碼新增一個值（向後相容的擴充）；用量事件新增可選欄位；egress `reasonCode` 由字串收斂為既有值的封閉集合，既有值語意不變。

## 風險

- 使用 fake-ip 代理的開發者或面試官，修正後仍會被 egress policy 拒絕（刻意的安全行為）；以 README 疑難排解與清楚的 `PRIVATE_ADDRESS` reason 降低排查成本。
- README 修改可能與 1A-3（README 改寫）衝突；實作前先確認 1A-3 狀態。

## 回滾策略

- 程式變更集中於 backend，可整體 revert 本 Change 的 commit。
- 新錯誤碼與事件欄位為擴充，回滾不需資料遷移。
