## 前置

- Primary Implementer：Codex。Secondary Architecture Reviewer：Qwen（`plan` 模式）。
- 實作前 MUST 讀取：根 `AGENTS.md`、`backend/AGENTS.md`、本 Change 全部 artifacts、`openspec/specs/egress-governance/spec.md`、`openspec/specs/governed-knowledge-retrieval/spec.md`。
- 測試 MUST 以注入的 DNS／connect 依賴執行，不得連真實外網；live 驗證另列於第 4 節。
- 每個 Task 完成後執行 `cd backend && npm run lint && npm run test && npm run build`；未通過不得勾選。
- 範圍調整（2026-10-29 Master 決定）：只做 egress 原因分類（第 1–2 節）與 README 疑難排解（第 3 節）。部署 proxy 路由拆到後續 Change；compose 與 `.env.example` 不修改。

## 1. egress reason 封閉集合

- [x] 1.1 以單一來源常數定義 egress reason 封閉集合（design D1 所列既有值），每個 reason 綁定固定分類；`EgressDecision`、`EgressPolicyError` 改用該型別；未知值處理為明確 `UNKNOWN`。
- [x] 1.2 測試：每個既有 deny／unavailable 路徑回傳的分類與 reason 不變（回歸）；未知值處理；取消與逾時不產生 egress 分類。
- [x] 1.3 回歸：`web_search`、`web_fetch`、`current_weather`、`weather_forecast`、地理編碼的既有 egress 測試，以及 `backend/src/operations/architecture-checks.ts` 的既有檢查全部通過。
- 對應：egress-governance「egress 失敗 MUST 保留有型別的原因分類」。
- 驗證：`cd backend && npx vitest run src/runtime/tool-dispatch src/tools`，再跑全套驗證命令。

## 2. knowledge 保留 egress 分類與用量事件

- [x] 2.1 knowledge 錯誤碼新增 `EGRESS_POLICY_UNAVAILABLE`（非 retryable）；模型閘道依 egress 分類對應 `EGRESS_DENIED`／`EGRESS_POLICY_UNAVAILABLE`，`KnowledgeError` 攜帶 egress reason，message 改為不含 hostname／IP 的固定文字。
- [x] 2.2 `knowledge.model.usage` 新增可選 `egressReasonCode`，只在 egress 失敗時出現。
- [x] 2.3 入庫 fatal 清單加入 `EGRESS_POLICY_UNAVAILABLE`。
- [x] 2.4 檢查 `kb_search` 與 tool result 對新錯誤碼的承接（typed failure、非空結果）；確認 frontend 既有未知錯誤降級可承接（只讀確認，不修改 frontend）。
- [x] 2.5 測試：私網位址（含 `198.18.0.0/15`，即本次原始失敗案例）對應 `EGRESS_DENIED`＋`PRIVATE_ADDRESS`；DNS 失敗對應 `EGRESS_POLICY_UNAVAILABLE`＋`DNS_RESOLUTION_FAILED`；用量事件含正確 `egressReasonCode`，且序列化後不含 URL、IP 或測試憑證；入庫遇 unavailable 立即結束且不再呼叫 embedding；取消仍回 `KB_CANCELLED`。
- [x] 2.6 `kb_search` typed failure 新增可選 `egressReasonCode`，shopping assistant 的 failure schema 同步接受；測試兩種 egress 錯誤都保留 reason，且 shopping assistant 不回 `KB_SEARCH_RESULT_INVALID`。
- [x] 2.9 shopping assistant 的 failed outcome 帶可選 `egressReasonCode`（集合外的值為 `UNKNOWN`），寫入 `shopping.product.lookup_failed` 與 `shopping.policy.lookup_failed` audit；有測試。
- [x] 2.7 rerank egress 失敗維持 recall-only，`degradation` 保留原分類與 reason；測試 deny 與 unavailable。
- [x] 2.10 `CONNECT_HOST_MISMATCH` 記錄 audit decision `deny`，覆蓋同一次 egress 先前的 `allow`；有測試。
- [x] 2.11 真實 undici 將 connector 錯誤包成 `TypeError` 時，還原 `EgressPolicyError` 以保留分類與 reason；以真實 undici 測試，不對外連線。
- [x] 2.12 評測 runner 保留 rerank 降級的 egress 分類與 reason；有測試。
- [x] 2.8 DNS unavailable 記錄 audit decision `unavailable`，redirect 後失敗會覆蓋先前的 `allow`；ledger 能解析 `unavailable`（執行期 decision 寫回列入後續 Change）；tool result envelope 依 design D2 寫 `null`，分類由 `errorCode` 保留。
- 對應：governed-knowledge-retrieval MODIFIED Requirement 的「憑證不可解析或 egress 被拒」「egress 無法完成評估」「查詢端 embedding 遇到 egress 失敗」「rerank 遇到 egress 失敗」「入庫遇到 egress 失敗即結束 run」「呼叫被取消」；egress-governance「DNS 解析失敗不得報為 deny」。
- 驗證：`cd backend && npx vitest run src/knowledge`，再跑全套驗證命令。

## 3. 文件

- [x] 3.1 README 新增疑難排解（design D3）：fake-ip 類代理工具的排除方式與 egress 目的地網域；`.env` 的主機用 `KNOWLEDGE_DATABASE_URL` 會進入容器；不在語料中的商品回 `no_source_found` 屬正確行為。
  - 2026-10-31：疑難排解內容由 Codex 依 Master 指派補入 `docs/troubleshooting.md`，README 連到該文件；CCR 已核對網域與 Compose 行為。
  - 2026-10-29：本 Change 寫入 README 的段落已被 README 改寫覆蓋，疑難排解移至 `docs/troubleshooting.md`（不在本 Change 寫入範圍）。該檔「商品查詢或政策問答失敗」已涵蓋三項重點；尚缺 egress 目的地網域清單，以及 `EGRESS_POLICY_UNAVAILABLE`／`DNS_RESOLUTION_FAILED` 與 `egressReasonCode` 的說明，交由 README 改寫的 Change 整合。
- [x] 3.2 確認 README 修改不與 1A-3（README 改寫）衝突；若 1A-3 已在進行，改為把段落內容交給該 Change 整合。
- 驗證：人工檢查內容與 design D3 一致，且不含 Secret、真實帳密或私人網路資訊。

## 4. Live 驗證（需 Master）

- [x] 4.1 修正版容器重建後，Master 以可通的本機環境執行 `docker compose up -d`（`.env` 不含主機用的 `KNOWLEDGE_DATABASE_URL`，或以 shell 變數改正）。
- [x] 4.2 在 bff 容器入口跑兩個 smoke：Gun Shop 問語料中實際存在的商品（例如「有推薦的 Tonic Earbuds 嗎？」），`kb_search` MUST 回 `evidence_found` 並附引用；Gun Chat 開深度研究問「大寮天氣?」，天氣工具 MUST 回天氣結果或候選地點。「快煮壺」不在語料中，回 `no_source_found` 是正確拒答，不能當成功或失敗的判準。
- [x] 4.3 在 fake-ip 環境（或以測試替身模擬）確認 `kb_search` 失敗時，錯誤碼為 `EGRESS_DENIED`、用量事件的 `egressReasonCode` 為 `PRIVATE_ADDRESS`。
- [ ] 4.4 以 4.2 的結果重跑 X43 的 T10 live 驗證，結果寫入 evidence。
- 修正前基線（2026-10-29，Master 以本機環境調整取得，尚未套用本 Change 的程式修正）：使用不發 fake-ip 的線路，並以 shell 變數讓容器的 `KNOWLEDGE_DATABASE_URL` 指向 `knowledge-postgres:5432`。天氣能取得候選地點；「Tonic Earbuds」回 `evidence_found`，附 5 筆引用；「快煮壺」回 `no_source_found`（召回 20 個候選，0 個通過門檻）；退款審批卡正常出現並可核准、拒絕或取消。
- 驗證：live smoke，不得以 mock 結果替代；未執行者在 readiness-check 標示。

## Master 事項（不屬於實作 Task）

- H1／H2 判定結果（2026-10-28）：H1。DNS 回傳 `198.18.0.71`、`2001:2::46`；容器內無 `*_PROXY` 變數。
- 本機環境：使用 fake-ip 時，需把 egress 目的地網域排除在 fake-ip 之外。Clash Verge 的「DNS 覆寫」會整份替換 DNS 設定，可能造成全面斷線；Master 目前改用不發 fake-ip 的線路。
- 部署 proxy 路由的後續 Change：視 D5 雲端環境是否需要 proxy 再開。
