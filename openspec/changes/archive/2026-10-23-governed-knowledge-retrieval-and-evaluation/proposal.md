# Proposal：governed-knowledge-retrieval-and-evaluation

## 變更摘要

本 Change 對應 `second-stage-plan-en-v6.md` 的 **X42**，依 `second-stage-plan-en-v7.md`（Business-Chain-First）調整後的範圍與證據時程執行，屬 Second Stage — Layer 9.5（Capability Fast Lane）。

OpenSpec profile：**lite**，依 ADR-FL-001（v6 定義；決策內容收錄於本 Change `design.md` §1）。lite 仍必須包含：tool contract、事件族與版本、成功／拒絕／對抗 Scenario、typed failure taxonomy、副作用的 idempotency 聲明、每項儲存或索引產物的資料分級。可延後項目記入 Retrofit Debt Register。

前置依賴（皆已在 `master`）：X14 unified dispatch、X20 durable HITL、X23 data inventory／deletion coordinator、X25 SecretBroker／egress policy、X27 agent tool SDK／manifest。**不依賴任何 X28 產物**（v7 決策）。

本 Change 是 v7 業務鏈路「售後客服：找商品 → 問退貨政策（RAG 帶引用，沒證據就拒答）→ 申請退款 → HITL 確認 → 冪等執行 → 狀態回報」的前兩個環節，以及鏈路驗收中的「檢索品質表」。退款、HITL 與狀態回報屬 X43（`commerce-assistant-and-approved-side-effects`），不在本 Change。

## 問題描述

1. **沒有私有語料檢索能力**：目前 runtime 只有 web search／web fetch 與天氣等 tool，沒有針對自有商品與政策文件的檢索。回答政策類問題時只能依賴模型參數知識，無法提供可驗證的來源。
2. **LLM Gateway 只支援 chat completions**：`ModelPurpose` 僅有 chat／math／research／vision／tool，沒有 embedding 與 rerank 呼叫路徑、capability flag 或用量事件。若在 tool 或入庫腳本中直接呼叫供應商 API，會繞過 SecretBroker、egress policy 與 tracing。
3. **沒有「無證據即拒答」的契約**：既有回答流程沒有證據門檻概念；檢索結果不足時，模型仍可能以參數知識作答而不聲明來源缺失。
4. **檢索品質無法量測**：既有 Opik evaluation 涵蓋 response quality 與 tool-call correctness，沒有 Recall@K、MRR、引用準確率與拒答率等檢索指標，也沒有可重現的檢索設定對比。
5. **衍生索引尚未納入資料治理**：X23 的 data inventory 已支援非權威衍生資料（projection／cache／backup），但沒有向量索引這類衍生產物的登記，來源刪除後殘留向量的風險沒有測試覆蓋。

## 解決方案

1. **獨立的 knowledge store**：以 pgvector 作為與 LangGraph checkpoint／runtime persistence 分離的服務（獨立 database 或獨立 instance，見 design §3），具版本化 migration。向量索引是**衍生、非權威**資料。
2. **TypeScript 入庫管線**：parse → normalize → deduplicate → chunk → batch embed → upsert。以 content hash＋source version 為自然鍵，可續跑、可重複提交且不重複嵌入。每個 chunk 記錄來源文件識別、來源版本、offset、資料分級與 ingestion run 識別。
3. **LLM Gateway 增加 embedding 與 rerank 用途**（additive）：沿用既有 provider 設定、SecretBroker 解析憑證與 egress policy 判定，新增 capability flag 與 typed failure；不改變既有 chat 路徑。
4. **`kb_search` tool**：經 X27 SDK manifest 宣告（read-only、`trusted_in_process`、egress 只允許模型服務 endpoint、資料分級依語料），經 X14 dispatch 執行。檢索階段：candidate recall → rerank → evidence threshold → citation binding。rerank 不可用時降級為 recall-only，並在檢索證據中標記。
5. **引用綁定與拒答**：答案引用必須可解析至已儲存 chunk；沒有任何候選通過證據門檻時，回傳明確的 no-source-found outcome，回答明確聲明知識庫未涵蓋。
6. **衍生索引參與資料治理**：knowledge store 登記到 data inventory（非權威、可重建）。來源文件刪除會連帶刪除 chunk 與索引項目，並以測試驗證刪除後零召回。
7. **檢索評測**：版本化 evaluation-case 契約（X35 的前向相容子集）、Recall@5／MRR／引用準確率／忠實度／拒答率 scorer，以 Opik experiment 執行 `vector-only` 與 `vector + rerank` 對比；模型評分附人工抽查紀錄。

## 受影響範圍

### 受影響套件

- **backend**：LLM Gateway（新增 embedding／rerank 用途）、knowledge store 與 migration、入庫管線、`kb_search` tool 與 SDK manifest adapter、data inventory 登記、Opik evaluation 擴充、合成語料與評測資料集。
- **frontend**：無行為變更。`kb_search` 結果經既有 tool 事件呈現；引用顯示沿用既有訊息渲染。若既有渲染無法辨識引用結構，列為 X43 範圍，不在本 Change 修改。
- **bff**：無變更。
- **deployment**：`docker-compose.yml` 新增 knowledge store 服務（pgvector）。

### 受影響能力域（capability）

- 新增 `governed-knowledge-retrieval`：knowledge store、入庫、`kb_search`、引用與拒答、衍生索引治理、Gateway 的 embedding／rerank 用途。
- 新增 `retrieval-evaluation`：evaluation-case 契約、檢索 scorer、設定對比與量測 provenance。
- 既有 `agent-tool-manifest`、`unified-tool-dispatch-pipeline`、`secret-broker`、`egress-governance`、`data-inventory`、`opik-evaluation`：**不修改其 Requirement**，本 Change 僅作為 consumer。若 review 發現必須修改，退回本 Proposal 補 MODIFIED delta。

## 目標

- `kb_search` 經 X27 manifest 註冊、經 X14 dispatch 執行，回傳可解析至 chunk 的引用。
- 拒答題回傳明確 no-source-found outcome。
- 產出 `vector-only` 與 `vector + rerank` 檢索品質表，含 dataset 版本、模型識別、prompt 版本、執行次數與日期，並附 ≥10 題人工抽查紀錄。
- 嵌入與 rerank 憑證只經 SecretBroker 解析；事件、checkpoint、log、trace、模型 context 中無憑證洩漏。
- 來源刪除後零召回；cross-tenant 召回被拒絕。

## 非目標

- 商品導購 graph、退款／取消 Tool、HITL、狀態 UI（X43）。
- 模型 turbo／plus／max 對比與路由表（X48）。
- 百煉託管版對照（D7，ADR only）。
- BM25 混合檢索（D8 follow-up）。
- Eval 進 CI（X45）。
- 圖片檢索與多模態 embedding（X47）。
- Python 檢索服務（X44）。
- X34 capability registry、X35 shadow／A-B、X38 accounting。
- OS 層級 sandbox（X28c）；本 Change 所有執行為 `trusted_in_process`。
- 真實業務語料；語料為合成資料並明確標註。

## 風險

| 風險 | 影響 | 緩解 |
|---|---|---|
| Gateway 擴充影響既有 chat 路徑 | 既有對話回歸 | embedding／rerank 為獨立用途與 endpoint kind；既有 Gateway 測試全數回歸 |
| embedding 維度或模型變更造成索引不一致 | 召回錯誤或 runtime error | 模型識別與維度為版本化設定；不一致時 typed failure，需走 reindex 路徑 |
| 證據門檻以單一案例調參 | 硬編碼、過擬合 | 門檻為版本化設定，以 dataset v1 的 dev split 決定並記錄；不得為單題加分支 |
| 模型評分不可信 | 量測失真 | 強制人工抽查樣本並記錄；不可重現的數字不發布 |
| 合成資料被誤解為線上效果 | 對外誤導 | 語料 header、README 與對外說明一律標註合成資料 |
| 檢索內容夾帶指令 | prompt injection | chunk 內容視為資料，不作為指令；加入對抗 Scenario |
| 供應商 rate limit／逾時 | 入庫中斷或回答失敗 | 有界併發、可續跑入庫；查詢時 typed failure 與降級 |

## 回滾策略

- 所有變更為 additive：新 tool、新 Gateway 用途、新 store、新 migration。
- `kb_search` 透過註冊開關進入 tool registry；停用即從 registry 移除，不影響既有 tool。
- knowledge store 為衍生資料，可整體清除並由來源重建；migration 只建立新 schema，不修改既有 runtime persistence 表。
- Gateway 新用途不改變既有用途的設定與行為；回滾時移除新用途設定即可。
