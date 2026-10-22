# Proposal：readme-architecture-diagram

## 問題

三份語言版本的 README（繁中、英文、简中）在「架構」章節只用一段 ASCII 文字流程描述系統：

```text
Browser -> frontend -> bff -> backend -> Model Provider / Native Tools / MCP Tools
```

這段描述無法呈現下列已實作的結構，讀者無法從 README 理解請求實際經過的層次：

- Backend 內的四個 Graph（`deep_researcher`、`chatbot`、`math_agent`、`mcp_agent`）。
- 所有 Graph 共用的 LLM Gateway，以及其後的三個 Provider（Qwen、OpenAI-compatible、CCR）。
- 哪些 Graph 經由 Tool Registry 使用 Native tools 與 MCP servers。
- OpenTelemetry 與 Opik 的接入位置。

本 change 屬於 Fast Lane 規格（`fastlane-d0-diagram-eval-spec.md`）的 D-1「系統與部署視圖」。

## 解決方案

以 Mermaid `flowchart` 取代三份 README 架構章節中的第一段 ASCII 流程塊，並在圖上方加一句說明這張圖回答的問題。三份 README 的圖結構完全一致，只在地化少數標籤。

相對 Fast Lane 規格原始 D-1 草圖的兩項調整（已由 Human 2026-10-22 裁定）：

1. **移除** `kb_search` 與 Vector store 節點：X42 尚未實作，不得畫出不存在的能力。
2. **新增** `math_agent → Tool Registry` 邊：程式碼中 `math_agent` 經 Tool Registry 載入 calculator tool，原草圖漏畫。

## 目標

- 三份 README 的架構章節以 Mermaid 圖呈現：請求從瀏覽器到 Model Provider 經過的層次，以及可觀測性的接入位置。
- 圖上每個節點與邊都對應已實作、可在程式碼中找到的元件與呼叫關係。
- 三份 README 的圖節點 ID 與邊集合完全相同。
- GitHub 能實際渲染該圖。

## 非目標

- 不新增 README 的評測章節、badge 或任何數字。
- 不修改 `docs/` 下任何文件，包含 Deep Researcher 節點流程圖（D-4）。
- 不繪製 X42（檢索）或 X43（副作用審批）相關節點。
- 不修改任何程式碼、測試、設定或規則檔。
- 不修改 README 架構章節以外的內容；目錄對照表、說明段落與 localhost 代理 ASCII 塊保留。

## 受影響範圍

| 項目 | 影響 |
|---|---|
| 套件 | 無；只改根目錄文件 |
| 能力域 | 專案文件（新增 capability：`readme-architecture-diagram`） |
| 公開契約、API、事件、Schema | 無 |
| 安全 | 無；圖上不含 URL、Port、憑證或內部主機名 |

## 風險

| 風險 | 嚴重度 | 緩解 |
|---|---|---|
| Repo 首次使用 Mermaid，GitHub 渲染失敗 | Low | 標籤一律加雙引號、不用 `&` 簡寫；推送後實際檢視三份 README |
| 三份 README 的圖結構漂移 | Low | 以腳本比對節點 ID 與邊集合 |
| 圖與程式碼不一致（現在或日後） | Medium | Design 列出每個節點與邊的程式碼依據；日後新增 Graph、Provider 或 Tool 路徑時須同步更新圖 |

## 回滾策略

純文件變更。回滾方式為還原三份 README 的架構章節至原 ASCII 流程塊（`git revert` 對應 commit 即可），無資料遷移、無執行期影響。
