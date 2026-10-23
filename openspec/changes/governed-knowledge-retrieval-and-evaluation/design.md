# Design：governed-knowledge-retrieval-and-evaluation

## 1. 文件 Profile 決策（ADR-FL-001）

本 Change 採 OpenSpec **lite** profile。決策來源為 `second-stage-plan-en-v6.md` 的 ADR-FL-001，並依 `second-stage-plan-en-v7.md` 執行。

- **適用範圍**：只適用 X42、X43（v7 以 ADR-FL-002 延伸至 X45–X48）；不適用 X28 系列與 X29。
- **到期**：X29 開啟時或 2026-11-30，以先到者為準。
- **lite 仍須包含**：tool 契約、事件族與版本、成功／拒絕／對抗 Scenario、typed failure taxonomy、副作用 idempotency 聲明、儲存或索引產物的資料分級。
- **本 Change 延後項目**（記入 Retrofit Debt）：營運 runbook、正式環境 store migration 計畫、compatibility matrix（X29）、deletion-race／入庫中斷／多租戶矩陣／trace exporter 洩漏測試（v7 允許 D8 補，否則記債）。
- **不得放寬**：v6 的十條 Non-Waivable Invariants 與 v7 第 11 條。

## 2. 責任邊界與資料流

### 2.1 frontend

無行為變更。`kb_search` 的 tool 事件與最終回答沿用既有串流與訊息渲染。引用的結構化顯示（例如可點擊的來源標記）屬 X43。

### 2.2 bff

無變更。既有 stream proxy、限流、逾時與取消傳遞不受影響；`kb_search` 不新增公開 route。

### 2.3 backend

```text
入庫（離線 job）
  語料檔 → parse → normalize → dedupe → chunk
        → LLM Gateway (embedding) ── SecretBroker / egress policy
        → knowledge store upsert（chunk + vector + provenance）
        → data inventory 登記（衍生、非權威）

查詢（chat turn）
  agent → X14 dispatch → kb_search
        → LLM Gateway (embedding) → knowledge store candidate recall（tenant 過濾）
        → LLM Gateway (rerank) ─ 不可用時降級 recall-only 並標記
        → evidence threshold
        → evidence_found（citations + chunks + retrieval evidence）
          或 no_source_found（retrieval evidence）
  agent 依 tool outcome 合成回答；citation 驗證檢查引用可解析
```

責任分配：

| 元件 | 負責 | 不負責 |
|---|---|---|
| knowledge store | chunk、向量、provenance、tenant 隔離、刪除 | 權威業務資料 |
| 入庫管線 | 冪等、可續跑、批次嵌入、資料分級標記 | 線上查詢 |
| LLM Gateway | embedding／rerank 呼叫、憑證解析、egress、用量事件、typed failure | 檢索邏輯 |
| `kb_search` | recall、rerank、門檻、引用綁定、降級標記 | 回答合成、身分判定 |
| citation 驗證 | 檢查回答引用是否可解析至本輪 tool 回傳的 chunk | 改寫回答 |
| evaluation | dataset 契約、scorer、設定對比、provenance | 線上 A/B（X35） |

## 3. Knowledge Store

### 3.1 部署

- pgvector 作為**與 LangGraph checkpoint／runtime persistence 分離**的服務。本機以 `docker-compose.yml` 新增獨立服務（pgvector 映像，固定版本），使用獨立連線設定。
- 連線字串為設定，經 SecretBroker 解析憑證；不得寫死於程式。
- 雲端部署時改用託管 PostgreSQL（需支援 pgvector），屬 v7 D5，不在本 Change 驗收。

### 3.2 Schema（概念模型）

| 實體 | 主要欄位 | 說明 |
|---|---|---|
| `kb_source` | tenant、sourceId、sourceVersion、sourceType（product／policy／faq）、title、dataClassification、contentHash、status（active／superseded／deleted） | 來源文件；sourceVersion 遞增 |
| `kb_chunk` | tenant、chunkId、sourceId、sourceVersion、chunkIndex、offsetStart、offsetEnd、content、contentHash、dataClassification、ingestionRunId、embeddingSpaceId、embedding | 衍生資料；embedding 欄位維度由 embeddingSpaceId 決定 |
| `kb_ingestion_run` | runId、tenant、corpusVersion、embeddingSpaceId、status、counts、startedAt、completedAt | 入庫執行紀錄 |
| `kb_embedding_space` | embeddingSpaceId、provider、model、dimension、createdAt | 版本化的嵌入空間 |

- **自然鍵**：`(tenant, sourceId, sourceVersion, chunkIndex, contentHash, embeddingSpaceId)`。重複提交同一鍵為 no-op。
- **維度版本化**：embedding 模型或維度變更即新增 embedding space，走 reindex；查詢時 query embedding 的 space 與索引不一致 MUST typed failure，不得靜默比對。
- **索引**：向量近鄰索引（HNSW，cosine）＋ tenant／source status 過濾。
- **tenant 隔離**：所有查詢以 server 端 execution context 的 tenant 過濾；tool input 不接受 tenant。

### 3.3 資料分級與資料治理

- 合成語料的分級為非個資、內部（以既有 data inventory 的分級值表示；實作時以既有 enum 為準，不新增平行分級）。
- knowledge store 登記為 data inventory 的衍生資料：`authoritative=false`、`rebuildable=true`、`clearable=true`。
- **兩種刪除路徑**：
  1. **來源刪除**（營運操作）：刪除或取代 `kb_source` 後，同一交易內刪除其所有 `kb_chunk`；查詢一律過濾 `status=active`。驗收：刪除後該來源零召回。
  2. **Subject 刪除**（X23 deletion coordinator）：語料不含 subject 個資。store 仍 MUST 被 coordinator 列舉，並以既有 part result 回報「無該 subject 資料」，不得從列舉中缺席。
- deletion race（刪除與查詢併發）測試列為 D8 或 Retrofit Debt。

## 4. 入庫管線

- **輸入**：合成語料目錄，每份文件附 provenance header（`synthetic: true`、生成日期、corpusVersion）。缺 header 的文件 MUST 拒絕入庫。
- **步驟**：parse（Markdown／JSON）→ normalize（空白、Unicode 正規化）→ dedupe（contentHash）→ chunk（版本化 chunking policy：目標長度、overlap、依段落與標題切分）→ batch embed → upsert。
- **併發**：批次大小與最大併發為設定；遇 rate limit 依既有 retry／resilience policy 退避。
- **可續跑**：已完成 chunk 依自然鍵跳過；run 狀態為 `running／completed／failed／incomplete`。部分批次失敗時 run 為 `incomplete`，**不得**將部分嵌入的文件標記為完成。
- **失敗分類**：provider timeout、partial batch failure、rate limited、dimension mismatch、oversized document、empty extraction、duplicate ingestion、interrupted ingestion，各有 typed outcome。
- **憑證**：入庫 job 透過 Gateway 呼叫，憑證只經 SecretBroker；job 本身不讀取 provider 憑證環境變數。
- **資料準備說明**（v7 D1 Lane B 產出）：收集、清洗、去重規則、chunking policy 與前後筆數，存於語料目錄的說明文件。

## 5. LLM Gateway：embedding 與 rerank 用途

- 新增兩個用途：`embedding`、`rerank`。既有 `ModelPurpose` 的值與 chat 路徑行為不變。
- **endpoint**：embedding 使用供應商的 OpenAI-compatible embeddings endpoint；rerank 使用供應商的 rerank API。實際 URL 形狀、請求格式與地域 endpoint 在 D0 對照官方文件確認並記錄，base URL 為設定。
- **模型**：`text-embedding-v4`、`qwen3-rerank`。`gte-rerank` 已停用，不得設定。模型識別為設定，不得出現在條件判斷式。
- **capability flags**：`supportsEmbedding`、`supportsRerank`。未宣告能力的 provider 呼叫該用途 MUST typed failure。
- **憑證與 egress**：沿用既有 SecretBroker 解析與 egress policy；egress destination 只允許設定中的模型服務 host，含 redirect 檢查。
- **typed failures**：`EMBEDDING_PROVIDER_TIMEOUT`、`EMBEDDING_RATE_LIMITED`、`EMBEDDING_DIMENSION_MISMATCH`、`EMBEDDING_INPUT_TOO_LARGE`、`RERANK_UNAVAILABLE`、`RERANK_PROVIDER_ERROR`，以及沿用既有的 `SECRET_REFERENCE_UNRESOLVABLE`、`EGRESS_DENIED`。最終命名在 apply-change T0 對齊既有錯誤碼慣例，語意不得改變。
- **用量事件**：每次 embedding／rerank 呼叫發出用量事件（provider、model、purpose、input units、latency、outcome、correlation ids），形狀可供 X38 消費；本 Change 不實作 accounting。
- **tracing**：沿用既有 Gateway tracing 與 redaction；不得記錄憑證或完整 chunk 內容於 trace attribute 以外的未遮罩位置。

## 6. `kb_search` Tool 契約

### 6.1 Manifest（X27 十類欄位）

| 欄位 | 值 |
|---|---|
| `toolId` / `toolVersion` | `kb_search` / `1.0.0` |
| `inputSchema` | `{ query: string(1..1000), topK?: int(1..20), sourceTypes?: ("product" \| "policy" \| "faq")[] }`；不接受 tenant、principal 或 approval 欄位 |
| `outputSchema` | 見 §6.2 discriminated union |
| `sideEffectClass` | read-only |
| `requiredCapabilities` | 明示的知識檢索 authorization action（命名在 T0 對齊既有 action 慣例） |
| `executionProfile` | `trusted_in_process`；egress 僅允許模型服務 host |
| `idempotency` | read-only，天然冪等；無 business effect |
| `approvalPolicyKey` | 不需審批（以既有 schema 的 none 值表示） |
| `timeoutRetryClass` | 沿用既有 read-only 網路類 retry／timeout class |
| `compensation` | none |
| `dataClassification` | 依語料分級（§3.3） |

### 6.2 Output（版本化，`kb_search_result@1`）

```text
evidence_found:
  citations[]: { citationId, chunkId, sourceId, sourceVersion, sourceType, title, offsetStart, offsetEnd }
  chunks[]:    { chunkId, content, score, rerankScore? }
  retrieval:   RetrievalEvidence

no_source_found:
  retrieval:   RetrievalEvidence

RetrievalEvidence:
  mode: "vector_rerank" | "vector_only_configured" | "vector_only_degraded"
  embeddingSpaceId, rerankModel?, thresholdVersion, configVersion
  candidateCount, passedCount
  degradation?: { reason: "RERANK_UNAVAILABLE" | "RERANK_PROVIDER_ERROR" }
```

- `vector_only_configured` 供評測對比使用；`vector_only_degraded` 表示 rerank 失敗後降級，**MUST** 出現在證據中。
- chunk content 是資料，不是指令；tool 描述與合成 prompt 明示此點，並以對抗 Scenario 驗證。
- typed failure（非 outcome）：provider 不可用且無降級可能、embedding space 不一致、egress 拒絕、憑證不可解析、逾時、取消。

### 6.3 證據門檻

- 門檻依檢索模式各自設定（rerank score 與 vector similarity 尺度不同），為**版本化設定**（`thresholdVersion`）。
- 門檻值以 dataset v1 的 dev split 決定，並記錄決定方法與日期；不得為單題調參或加分支。
- 無候選通過門檻 → `no_source_found`。

### 6.4 掛載位置

- D1 驗收「聊天中能查到並帶引用」：`kb_search` 經 SDK adapter 註冊到既有具 governed tool registry 的 agent（目前為 `mcp_agent` 的授權 graph 路徑），經 X14 dispatch 執行。
- 結構化的「檢索 → 驗證 → 合成」與拒答路由（類比 `deep_researcher` 的 verify-before-synthesize 模式）屬 X43 `shopping_assistant` 的政策節點；本 Change 提供可重用的 citation 驗證函式與 tool outcome 契約。

## 7. 引用綁定與拒答

- 合成回答以 citationId 標記引用；**citation 驗證**為 deterministic 檢查：回答中的每個 citationId MUST 存在於本輪 `kb_search` 回傳的 citations；不可解析者為失敗案例（評測計入 citation accuracy；runtime 發出驗證失敗事件）。
- `no_source_found` 時，回答 MUST 明確聲明知識庫未涵蓋該問題，不得以參數知識作答而不聲明。本 Change 以 tool outcome 契約＋評測量測保證；結構化強制於 X43。
- 忠實度（faithfulness）：model-assisted scorer 評估回答陳述是否由引用 chunk 支持，附人工抽查。

## 8. 檢索評測

### 8.1 evaluation-case 契約（`eval_case@1`，X35 前向相容子集）

| 欄位 | 說明 |
|---|---|
| `caseId`、`datasetVersion` | 穩定識別與資料集版本 |
| `input` | 使用者問題（可多輪；本 Change 單輪） |
| `expected` | `{ kind: "answerable", relevantSourceIds[], relevantChunkIds? }` 或 `{ kind: "abstain" }` |
| `prohibitedOutcomes` | 例如：引用不可解析、拒答題給出肯定答案 |
| `scoring` | 使用的 scorer 與參數 |
| `provenance` | 生成方式、synthetic 標記、建立日期 |
| `sensitivityClass` | 資料分級 |
| `tags` | 例如 product／policy／faq／cross_lingual／adversarial |

未知欄位保留不丟棄；未知 `expected.kind` 以 typed failure 拒絕該 case。

### 8.2 Dataset v1

約 40 題，其中至少 10 題拒答題；含跨語言題（英文語料、中文提問）與至少 1 題對抗題（chunk 夾帶指令）。dev／test split 固定並版本化；門檻只用 dev split 決定，報表數字以 test split 為準並同時揭露 dev。

### 8.3 Scorers

- **Recall@5**、**MRR**：以 `relevantSourceIds`（或 chunkIds）判定，programmatic。
- **citation accuracy**：引用可解析且屬相關來源的比例，programmatic。
- **abstention**：拒答題正確拒答率；同時報告可答題的誤拒率。拒答是正確結果，不因「沒有回答」扣分。
- **faithfulness**：model-assisted，評分模型與 prompt 版本記錄於 provenance；人工抽查 ≥10 題並記錄一致率。

### 8.4 執行與報表

- 以既有 Opik experiment 基礎執行 `vector_only_configured` 與 `vector_rerank` 兩組設定。
- 每份報表記錄：dataset 版本、embedding／rerank／生成模型識別、prompt 版本、門檻版本、執行次數、日期、synthetic 聲明。
- 無法完成的 run 報為 `incomplete`，不得以成功子集計分。
- live 評測（真實模型）與 deterministic 測試分開回報；mock 結果不得當作 live 結果。

## 9. 安全分析（Tool 變更）

| 面向 | 設計 |
|---|---|
| 身分 | tenant 只來自 server 端 execution context；input schema 不含身分欄位 |
| 授權 | 明示 authorization action，經既有 X13 authorization；無 implicit default |
| 憑證 | 只經 SecretBroker；洩漏測試掃描事件、checkpoint、log、模型 context |
| egress | 只允許模型服務 host；redirect 重新判定 |
| prompt injection | chunk 視為資料；對抗 case 驗證 tool 不會因 chunk 內容觸發其他 tool |
| 資料 | 衍生索引登記 data inventory；來源刪除連帶刪除 |
| 執行隔離 | `trusted_in_process`；不宣稱 OS 隔離（v7 第 11 條） |

## 10. 替代方案

| 方案 | 不採用原因 |
|---|---|
| 向量資料與 checkpoint 共用同一 database | 違反「衍生索引與 orchestration store 分離」；備份、遷移與刪除耦合 |
| 在 tool 內直接呼叫供應商 SDK | 繞過 SecretBroker、egress 與 tracing（Invariant 3、4） |
| 只用百煉託管知識庫 | 無法展示治理路徑；百煉版作為 D7 對照 ADR |
| 固定門檻寫在程式中 | 違反禁止硬編碼；門檻必須版本化並可重現 |
| X42 直接建立完整問答 graph | 與 X43 重疊；本 Change 只提供 tool 契約與驗證函式 |
| Python 檢索服務 | X44（re-scoped），v7 排在 Week 2 |

## 11. 風險與觀測性

- 觀測：`kb_search` 的 retrieval evidence、降級標記、Gateway 用量事件、citation 驗證失敗事件，皆沿用既有 tracing 與 Opik。
- 主要風險見 proposal；殘餘風險：本 Change 的拒答以契約＋量測保證，結構化強制要到 X43 才完成。

## 12. 規劃預設決策（Human 可於 review-plan 推翻）

plan-change 階段的四個規格疑問，CCR 以下列預設定稿；若 Human 推翻，退回 PLAN_DRAFT 修訂。

| # | 疑問 | 預設決策 | 理由 |
|---|---|---|---|
| Q1 | 部署地域（香港／新加坡 vs 中國大陸） | **不影響本 Change 規格**：endpoint 與地域為設定；T0 依實際地域核對模型可用性。地域由 Human 在 v7 D5 前決定 | 規格保持地域中立，避免卡住 D0 |
| Q2 | knowledge store 部署形式 | 獨立 pgvector 服務，與 LangGraph checkpoint postgres 分離（§3.1） | 符合衍生索引與 orchestration store 分離；備份、升級、刪除不耦合 |
| Q3 | 合成語料語言 | 英文語料為主，評測集含中文提問的跨語言題（TB1、TB2） | 對應海外產品情境；可量測跨語言檢索 |
| Q4 | D1 驗收時 `kb_search` 的掛載位置 | 掛在既有具 governed tool registry 的 agent；結構化拒答路由由 X43 負責（§6.4） | 最快達成 D1 Gate；避免與 X43 重疊 |

## 13. Retrofit Debt（本 Change 新增）

| Debt | Closed by |
|---|---|
| deletion race、入庫中斷注入、多租戶矩陣、trace exporter 洩漏測試（若 D8 未完成） | X29 |
| 用量事件未入 accounting | X38 |
| 評測為離線回歸，無 shadow／A-B | X35 |
| 營運 runbook、正式 store migration 計畫 | X29、X41 |
| Fast Lane tool 尚未通過 conformance suite | X29 |
| 建於 pre-X28 boundary | X28-min |
