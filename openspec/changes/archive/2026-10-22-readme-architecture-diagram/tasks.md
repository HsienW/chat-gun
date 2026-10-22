# Tasks：readme-architecture-diagram

> Primary Implementer：Codex。Secondary Architecture Reviewer：Qwen。施工內容以 `design.md` 的標準圖、在地化標籤與說明句為準。

## 1. 施工前核對

- [x] 1.1 依 `design.md`「圖的內容與程式碼依據」表逐項核對程式碼：四個 Graph、三個 Provider、連到 Tool Registry 的三個 Graph、可觀測性接入位置。任一項不符即停止並回報，不修改文件。驗證：在回報中逐項列出核對結果與檔案位置。對應 Requirement「圖上只包含已實作的元件與呼叫關係」。

## 2. 文件修改

- [x] 2.1 在英文版 README 的 Architecture 章節，以 `design.md` 標準圖與英文說明句取代第一段 ASCII 流程塊；保留目錄對照表、說明段落與 localhost 代理 ASCII 塊。驗證：`git diff -- README.en.md` 只顯示該流程塊被替換。對應 Requirement「架構章節以可渲染的圖呈現已實作的系統分層」、「變更範圍僅限架構圖」。
- [x] 2.2 在繁中版 README 的架構章節做相同替換，套用繁中在地化標籤與說明句。驗證：`git diff -- README.md` 只顯示該流程塊被替換。對應同上。
- [x] 2.3 在简中版 README 的架构章節做相同替換，套用简中在地化標籤與說明句。驗證：`git diff -- README.zh-CN.md` 只顯示該流程塊被替換。對應同上。

## 3. 驗證

- [x] 3.1 以腳本抽出三份 README 的 Mermaid 區塊，忽略標籤文字比對節點 ID 集合與邊集合（含實線／虛線類型）；預期三份皆為 17 個節點、21 條邊且完全相同。驗證：附上腳本與執行輸出。對應 Requirement「三種語言版本的圖結構完全一致」。
- [x] 3.2 確認變更範圍：`git diff --stat` 只列出三份 README；`git diff --check` 無錯誤；`openspec validate readme-architecture-diagram --strict` 通過。驗證：附上三個命令的輸出。對應 Requirement「變更範圍僅限架構圖」。
- [x] 3.3 推送至 GitHub 後實際開啟三份 README，確認架構圖渲染為圖形。驗證：附上三個檔案的 GitHub 連結或截圖；未推送則標記為未驗證，不得以本地預覽代替。對應 Scenario「讀者在 GitHub 檢視架構章節」、「Mermaid 語法無法渲染」。
