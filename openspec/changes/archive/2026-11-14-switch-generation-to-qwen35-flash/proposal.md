## Why

第二階段計畫 v7 r2（2026-10-28 Master 決策）定案：部署區域為新加坡，每日預算 CNY 1.5，Chapter 2 部署前所有 graph 改用 `qwen3.5-flash` 生成，並依 B12 關閉 thinking mode。這是 r2 Chapter 1B 的第一步（1B-1）。1B-2 到 1B-7（以 flash 重跑評測與比較、量測 E3 token、替換履歷數字）都依賴它；`demo-cost-and-access-guard` tasks 6.4(c) 也把本 Change 列為部署前 Gate。

目前狀況：

1. **生成模型分散在多處**。backend 依 `ModelPurpose`（chat、math、research、vision、tool）從環境變數解析模型；`.env.example` 全部預設 `qwen-plus`（vision 為 `qwen-vl-plus`）。Gateway 在環境變數都沒設定時，還有一個寫死在程式內的 `qwen-plus`／`qwen-vl-plus` 預設；kb-eval CLI 另有一個寫死的 `qwen-plus` 預設。chain-eval 用 `SHOPPING_ASSISTANT_MODEL`（實際跑的是 qwen3.7-plus）。
2. **thinking 參數只有部分呼叫會送出**。只有 `shopping_assistant` 會依 `SHOPPING_ASSISTANT_THINKING_ENABLED` 送出 `enable_thinking`；`chatbot` 只在 demo 模式下送出；`deep_researcher`、`math_agent`、`mcp_agent` 一律不送，交由 provider 預設決定。官方文件說 `qwen3.5-flash` 預設開啟 thinking（見 design「外部事實」）。所以只改模型名稱的話，這三個 graph 和非 demo 的 `chatbot` 會開始產生 reasoning token，按 output 單價計費，延遲也會變長。
3. **live chain-eval 沒有套用 Gun Shop 的 thinking 設定**。它建立模型時只帶 model 與 temperature，量到的設定會和 production graph 不同。
4. **評測 provenance 只記錄「要求的」模型名稱**。沒有記錄 thinking 設定、endpoint 區域，也沒有記錄 provider 回報的實際模型。所以 1B-2 的 qwen3.7-plus 對 qwen3.5-flash 比較缺少可稽核的依據。

## What Changes

- **預設生成模型改為 `qwen3.5-flash`**：涵蓋 5 個已註冊 graph 會用到的全部 `ModelPurpose`，包含 vision。做法是改設定範例，加上一個單一來源的程式預設常數，不依模型名稱分支業務邏輯。
- **thinking 預設關閉，並由 Gateway 統一送出**：Qwen provider 每次生成請求都明確送出 `enable_thinking`。值依序取自：入口層的明確設定 → 全站 thinking 預設設定（預設 `false`）。只對宣告支援 thinking 控制的 provider 送出，依據是 capability，不看模型名稱。
- **Gun Shop thinking 一律關閉**：依 B12，凡是會服務 `shopping_assistant` 的啟動流程，有效 thinking 值都必須是 `false`；明確設為 `true` 時拒絕啟動。這是對既有可接受值的收緊，見「相容性」。
- **fallback 鏈**：不新增模型層 fallback。既有 provider 層 fallback 維持預設關閉，語意不變。flash 未達 C1 品質門檻時要改用哪個模型，屬於 1B-2 的待決項。
- **評測 provenance 記錄實際模型**：kb-eval、chain-eval、order-request golden 的 provenance 都要記錄每個生成用途的設定模型、有效 thinking 設定、endpoint 主機（不含 secret），以及 provider 回應中實際回報的模型集合。live chain-eval 必須套用與 production graph 相同的 Gun Shop thinking 設定。為了讓這些欄位可信，Gateway 的回應 metadata 新增 provider 原始回報模型欄位（既有 `model` 不變），並提供有效 endpoint 主機的唯讀查詢（含內建預設）。這兩項是 apply-change-001 回報後補上的契約。
- **新加坡國際 endpoint 相容性的 live probe**：新增手動觸發、預設跳過的 live probe，驗證 `qwen3.5-flash` 在新加坡 endpoint 上的 text、JSON object 結構化輸出、Tool Calling、vision 與 `enable_thinking=false` 是否可用。結果寫入 evidence；未執行的項目如實標示。
- **回滾**：把模型相關設定改回 `qwen3.7-plus`／`qwen-plus` 即可，不需改程式。

## Capabilities

### New Capabilities

- `generation-model-profile`：生成模型的預設值、解析優先序、thinking 控制、Gun Shop thinking 啟動驗證、fallback 鏈語意、回滾與 endpoint 相容性驗證。
- `evaluation-model-provenance`：評測報表與 provenance 必須記錄的模型、thinking 與 endpoint 欄位，以及 live 評測與 production 的模型設定一致性。

### Modified Capabilities

（無。既有 `backend-model-runtime` 的 purpose 解析與 capability enforcement 語意不變，`runtime-env-defaults` 的「預設 provider 為 Qwen」也不變；本 Change 以新 capability 補充，不修改既有 Requirement。）

## Goals

- 每個已註冊 graph 在未另行設定時，實際送出的生成模型都是 `qwen3.5-flash`。
- 每個送往 Qwen 的生成請求都帶明確的 `enable_thinking`，預設 `false`。
- Gun Shop thinking 在啟動時驗證為關閉。
- 評測產出能說明「用哪個模型、thinking 開或關、打哪個 endpoint」，可供 1B-2 比較與 1B-7 履歷數字引用。
- 回滾只需改設定。

## Non-goals

- 不重跑 `knowledge:evaluate`、`commerce:evaluate`，不產出 qwen3.7-plus 與 qwen3.5-flash 的比較（屬 1B-2）。
- 不訂定或實作 C1 品質門檻，也不選定未達門檻時的 fallback 模型（屬 1B-2）。
- 不更換 embedding（`text-embedding-v4`）與 rerank（`qwen3-rerank`）模型或設定。
- 不更換評測 judge 模型（`KB_EVAL_JUDGE_MODEL`，預設 `qwen-max`）；judge 不是 graph 生成，是否換由 1B-2／D6 決定。
- 不實作 Gun Chat 的可選 thinking 開關 UI（B12 允許，另開 Change）。
- 不核實新加坡單價、不填正式單價表、不量測 E3（屬 `demo-cost-and-access-guard` 6.4(a)(b) 與 1B-6）。
- 不改 frontend 的模型選擇行為或 BFF。
- 不做新加坡實際佈建（屬 Chapter 2 D5）。

## Impact

- **backend**：LLM Gateway 的 Qwen 模型預設與 thinking 送出邏輯、provider capability 宣告、回應 metadata 新增 `provider_model`、有效 endpoint 主機唯讀查詢、Gun Shop 模型設定的啟動驗證、評測 CLI 與 provenance 型別、`.env.example`、新增 live probe 與測試。
- **bff**：無變更。
- **frontend**：無變更。
- **與其他 Change 的檔案重疊**：LLM Gateway 與 Gun Shop 模型設定目前也是 `demo-cost-and-access-guard`（READY_FOR_REVIEW，未提交）與 `stream-chat-answer-text` 的修改對象；kb-eval CLI 原為 `harden-kb-evaluation-baseline` 的修改對象（該 Change 已歸檔，檔案已釋放）。本 Change 依 design「檔案邊界與施工順序」分組施工，重疊檔案以檔案為單位檢查，必須等前一個 Change 釋放該檔案（Master 決策 OD-1 (a)，2026-11-04）。
- **成本**：依 r2 §4.1，新加坡 qwen3.5-flash 為 USD 0.1 in／0.4 out（每 1M token），低於 qwen3.7-plus。關閉 thinking 可避免 reasoning token 以 output 單價計費。正式單價仍待 6.4(a) 核實。

## 相容性

- Graph ID、BFF Route、事件與錯誤碼不變。
- 未設定模型環境變數的開發環境會從 `qwen-plus` 改為 `qwen3.5-flash`。有設定的環境依設定值，行為不變。
- 先前沒有送出 `enable_thinking` 的呼叫（`deep_researcher`、`math_agent`、`mcp_agent`、非 demo 的 `chatbot`）改為明確送出 `false`。對 `qwen-plus` 而言，這與 provider 原本的預設一致（未驗證，見 design）。
- `SHOPPING_ASSISTANT_THINKING_ENABLED=true` 原本可以接受，改為拒絕啟動，錯誤碼沿用既有的 `invalid_configuration:SHOPPING_ASSISTANT_THINKING_ENABLED`。
- provenance JSON 只新增欄位，舊報表不改寫；讀取舊報表時，缺少的新欄位視為「未記錄」。
- Gateway 回應 metadata 只新增 `provider_model`；既有 `model` 的值與代填語意不變，帳本與 tracing 不受影響。有效 endpoint 查詢是新的唯讀介面，不改變既有 health／readiness 回應。

## Risks

- **品質下降**：flash 在引用準確度、拒答與 Tool Calling 上可能不如 qwen3.7-plus。由 1B-2 以 C1 門檻驗收；未通過前不得替換履歷數字。
- **thinking 關閉後結構化輸出或路由行為改變**：由既有回歸與 1B-2 live 評測涵蓋。
- **新加坡 endpoint 功能差異未驗證**：live probe 未執行前，相容性只能以官方文件為依據，標示為未驗證。
- **檔案重疊造成施工延後**：見 OD-1。

## 回滾策略

1. 把 `QWEN_CHAT_MODEL`、`QWEN_RESEARCH_MODEL`、`QWEN_TOOL_MODEL`、`QWEN_VISION_MODEL`、`SHOPPING_ASSISTANT_MODEL`、`KB_EVAL_GENERATION_MODEL` 等設定改回 `qwen3.7-plus` 或 `qwen-plus`（vision 改回 `qwen-vl-plus`），重啟 backend，不需改程式。
2. thinking 預設維持 `false`。如需恢復 provider 預設行為，由 Master 決定是否把全站 thinking 預設設為 `true`；Gun Shop 仍依 B12 保持關閉。
3. demo 模式下，回滾後的模型必須已列在單價表，否則 `demo-cost-and-access-guard` 的啟動檢查會拒絕啟動（fail-closed，屬預期行為）。
