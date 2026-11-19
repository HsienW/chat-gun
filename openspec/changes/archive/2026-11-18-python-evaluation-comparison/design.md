## Context

評測產出的現況（2026-11-17 讀取）：

| 評測 | 產出位置 | run 檔內容 | provenance |
| --- | --- | --- | --- |
| kb-eval | `backend/data/knowledge-eval/results/<run>/run-<strategy>.json` | `strategy`、`status`、`failedCases`、`results[]`（逐題：`split`、`expectedKind`、`reciprocalRank`、`abstained`、`citationAccuracy`、`faithfulness`、`latencyMs` 等）、`summary`（`dev`／`test`／`all` 各含 cases、recallAt5、mrr、citationAccuracy、faithfulness、abstentionAccuracy、falseAbstentionRate、latencyP50Ms、latencyP95Ms 等） | `provenance.json`：datasetVersion、corpusVersion、embedding／rerank／generation／judge 模型、prompt 與設定版本、date；較新的 run 另有生成模型、thinking 與 endpoint 欄位 |
| research-eval | `backend/data/research-eval/results/<run>/run-<arm>.json` | `runnerVersion`、`datasetVersion`、`ranking`、`observations[]`、`scores[]`、`summary` | `provenance.json` |

TS 端的指標定義在 `backend/src/knowledge/evaluation/`（scorers、report）與 `backend/src/evaluation/research/scoring.ts`。另一個 Python 專案（im-agent）已把 research 的 `scoring.ts` 移植為 Python 並對已錄 run 驗證過一致，可作為移植起點。

## Goals / Non-Goals

見 proposal。

## 各套件變更

- **frontend／bff／backend**：無變更。
- **新增 Python 套件**（OD-1：`evaluation-py/`，套件 `chat_gun_eval`）：只依賴標準函式庫、pydantic 與開發工具；不依賴任何模型 SDK 或網路套件。
- **CI**：新增獨立 workflow，只在 Python 套件或評測結果目錄變更時觸發。

## Decisions

### D-1：唯一事實來源

TS scorer 是指標定義的唯一來源。Python 重算的目的是交叉驗證，不是另立定義：移植時逐一對照 TS 原始碼（加總方式、分母、空集合處理、percentile 演算法、split 分組），在 Python 原始碼註明對應的 TS 檔案與函式。兩者不一致時，以 TS 為準並回報差異，不得修改 Python 以外的檔案來「對齊」。

### D-2：輸入模型與 Runtime Validation

- 以 pydantic v2 模型描述 kb-eval run、research-eval run 與 provenance。模型設定容許未知欄位（`extra="allow"` 或等價做法），必要欄位缺失、型別錯誤或 enum 值不在已知集合時明確失敗，錯誤訊息包含檔案路徑與欄位路徑。
- 封閉集合（`status`、`expectedKind`、`split`、research `category`）以單一來源的常數定義並附測試；遇到未知值時失敗，不默默歸類。
- 讀檔只接受使用者指定的 run 目錄；不遞迴掃描整個 repo。

### D-3：摘要一致性（parity）

- 從逐題資料重算 `summary`，與檔案內 `summary` 比對。比對範圍是 TS `summary` JSON 的全部葉節點：kb-eval 為 `SplitSummary` 各欄位（各 split），research 為 `RunSummary` 的全部巢狀欄位（citation、refusal、clarify、fetchedUsable、routing、各類別延遲、rerank、citationGuard 等）。
- 條件性欄位：TS 以條件展開才加入的欄位（research 的 `rerank`、`citationGuard`），Python 在相同條件下產生、否則省略，不得以 null 或預設值補上；欄位集合不同視為不一致。
- 計數類（cases、answerableCases、abstainCases、completed 數等）與 percentile 延遲必須完全相同；比率類允許絕對誤差 `1e-9`。
- 任一指標不一致時，CLI 以非零狀態結束，輸出指標名稱、split、TS 值、Python 值。
- 回歸基準：`backend/data/knowledge-eval/results/` 與 `backend/data/research-eval/results/` 下全部已錄 run。若某個早期 run 的 `summary` 由當時不同版本的 scorer 產生而無法一致，必須在測試中以具名、附原因的例外清單列出，不得放寬容許誤差。

### D-4：跨 run 比較報告

- 輸入兩個以上 run（同一評測類型）。資料集版本（`datasetVersion`，kb-eval 另含 `corpusVersion`）不同時拒絕比較並以非零狀態結束；可用明確旗標允許跨版本比較，報告標題必須標示「跨資料集版本」。
- 報告內容：各 run 的 provenance 對照表（缺少的欄位顯示「未記錄」，不推測）、各指標各 split 的數值與相對第一個 run 的差異、每個指標的樣本數，以及「小樣本，一兩題的差異應視為雜訊」的提醒。
- 輸出 deterministic：同樣輸入產生位元組相同的 Markdown（固定排序、固定小數位、不含執行時間戳；時間只取自 provenance）。
- 先寫入暫存檔再原子性改名；中途中斷（例如 KeyboardInterrupt）不留下半份報告。

### D-5：離線與安全

- 套件不得 import 網路或模型 SDK；以測試檢查相依清單與 import。
- 不讀取 `.env*`；報告不包含逐題的 question、answer 或 evidence 全文，只含指標與 provenance。
- 本 CLI 為純本機檔案處理，沒有上游呼叫，因此不定義逾時與重試；取消以中斷處理（D-4 原子寫入）。

### D-6：工具鏈

- Python 3.12、uv 與 `uv.lock`（OD-2）。
- 品質門檻：formatter／linter、靜態型別檢查（strict 模式，禁止未註明理由的 `Any`）、pytest。
- CI workflow 執行上述三項與 parity 檢查；任何一項失敗即失敗。

### D-7：與 im-agent 的關係

research scorer 以 im-agent 的移植為起點（OD-3），帶入 chat-gun 後以 chat-gun 的 TS 原始碼重新逐項核對，不以 im-agent 的版本為準。不引入 im-agent 的其他模組（research agent、FastAPI 等）。

## 替代方案

- **在 TS 內加比較報告**：可行但不提供獨立交叉驗證，也不符合「專案有實質 Python 元件」的目標。
- **把評測執行整體移到 Python**：需要重做模型、Tavily、資料庫與 graph 呼叫，屬於大型重構，違反最小變更原則。
- **Python retrieval 服務（X44）**：屬 runtime 變更，需要新的跨層契約與部署，留待部署穩定後另議。

## Risks / Trade-offs

- **[語意漂移]** → D-3 的 CI parity 檢查。
- **[早期 run 無法一致]** → 具名例外清單，附原因，不放寬誤差。
- **[報告被誤讀為顯著差異]** → 報告固定附樣本數與小樣本提醒。

## review-plan 仲裁紀錄

`review-result-review-plan-001` 由 adapter 保存，evidence gate 通過，verdict APPROVE（0 Blocker／0 Major／2 Minor）。CCR 仲裁兩個 Minor 全部採納：

| Minor | 內容 | 採納位置 |
| --- | --- | --- |
| 1 | 比較報告與 parity 的指標範圍：明定為 TS `summary` 全部葉節點 | D-3、spec |
| 2 | research 條件性欄位（rerank、citationGuard）在 Python 端同條件產生或省略 | D-3、spec 新增 Scenario |

兩項皆為範圍明確化，不改變 Requirement 語意，不需重新審查。

## Master 決策（OD）

Master 於 2026-11-17 定案，三項皆採建議選項 (a)：

| ID | 問題 | 定案 | 理由 |
| --- | --- | --- | --- |
| OD-1 | Python 套件目錄與套件名稱 | 目錄 `evaluation-py/`，import 套件 `chat_gun_eval` | 與 frontend／bff／backend 平行，履歷與 README 容易指認 |
| OD-2 | Python 版本與相依管理 | Python 3.12 + uv，提交 `uv.lock`；CI 以 uv 安裝鎖定版本 | 鎖定可重現、CI 安裝快 |
| OD-3 | research scorer 的來源 | 以 im-agent（`C:\D\ai-agent\im-agent-python`，分支 `feat/research-eval-metrics`、`feat/python-research-agent`）的移植為起點，帶入後依 D-1、D-7 逐項對照 chat-gun `backend/src/evaluation/research/scoring.ts` 核對，以 TS 為準 | 已有一致性驗證，可縮短工時 |

OD-3 補充：im-agent 只作為唯讀參考來源，Implementer MUST NOT 修改 im-agent repository、切換其分支或引入 im-agent 的其他模組與相依；移植後的 Python 原始碼註明對應的 chat-gun TS 函式，不註明 im-agent 為事實來源。
