# Qwen 調用與授權容器實作紀錄

本次依專案擁有者聊天授權直接實作，不建立 OpenSpec change、CurrentState 或執行階段交接。實作者為 Codex。既有未提交的產品程式與設定變更不屬於本次範圍。

## 契約與實作

- 授權容器：`openspec/specs/agent-role-policy/master-authorization.schema.json`；hook 與 Master GC 共用 `tools/master-authorization.mjs`，Codex 亦依相同 schema 與 referenced resolver 精準查找。
- 舊單筆授權須含 authorizationId；Handoff 須指定 `master-authorization.json#<id>`。任一 entry 損壞即拒絕整份；多筆有效 scope 涵蓋同一目標拒絕，不做聯集。
- `authorizationSnapshot` 遞迴排序 object keys、保留 array 順序，以 JSON.stringify 序列化後計算 UTF-8 SHA-256；`verifyAuthorizationSnapshot` 驗證內容與 self_acceptance grant。快照不是新的授權。
- 現行 CurrentState／Handoff／AgentResult schema 從封存快照複製至主規格目錄後增加欄位，adapter 與測試引用主規格；封存檔不更動。
- GC 預設 dry-run，--apply 使用 temp file、hash 重查、rename。只有 Master 可執行 CLI；測試僅在臨時 fixture 呼叫匯出函式。
- adapter 在讀取 CurrentState 前取得每個 change 的獨佔 lock，finally 釋放；衝突不清除既有 lock。CurrentState 與讀取路徑執行 realpath 邊界檢查。

## Qwen 參數查證與限制

adapter 的 stream-json 解析與工具契約依 **Qwen 0.25.3** 查證（`VERIFIED_QWEN_VERSION`），其他版本的審查一律判 `qwen_version_unverified`。2026-10-30 本機 PATH 上的 `qwen` 是 0.26.3，尚未查證；0.25.3 只有隔離安裝。

查閱 0.25.3 安裝包原始碼：

| 工具 | 參數 | 說明 |
| --- | --- | --- |
| read_file | file_path（必填） | 絕對路徑 |
| grep_search | pattern、glob、path | path 省略時為 cwd |
| glob | pattern、path | path 省略時為 cwd |
| list_directory | path（必填）、ignore | 絕對路徑 |

0.25.3 沒有 read_many_files，該名稱不在 reviewer 白名單與 adapter 允許清單內。0.25.3 的 agent 工具預設在背景執行，事件不進 stream，因此 reviewer 設定 `background: false`。

目錄層級的 grep_search／glob 只在所有 settings 層級都沒有關閉 `context.fileFiltering.respectGitIgnore` 或 `tools.useRipgrep` 時放行，篩選條件不得指向禁止位置。未知參數、通配符路徑或無法解析的 settings 回報 read_scope_not_proven；不猜測工具預設範圍。明確路徑透過 git check-ignore --no-index 驗證，Git 驗證失敗亦保持 INCOMPLETE。Runtime 只允許本 change 的引用檔案；Web、MCP 與未知別名不在允許清單。

Windows 上 hook 白名單的 `-- qwen` 由 adapter 解析為 `node <cli-entry.js>`，不經 shell；`QWEN_CLI_ENTRY` 可固定使用的安裝，設定後即為唯一候選。

這是事後 evidence gate，不能撤回 Qwen 已讀取的資料；仍須保留 reviewer 的唯讀工具及宿主隔離。capture 的 readPaths 不保存內容，外部與疑似 secret 路徑遮蔽。

## 風險與回滾

- Bash 守門使用字串比對，不能阻擋混淆命令；一般宿主權限確認仍必須保留。此 hook 僅覆蓋 CCR；Codex 遵循技能與根規則，不能宣稱有通用 OS 強制隔離。
- GC 的 hash 重查可偵測檢查前的變動，但檢查與 rename 之間仍有極短競態視窗；Master 應避免同時手動編輯授權檔。
- stale lock 只由人工確認清除；不得由 agent 自動刪除。
- 舊授權若缺 authorizationId 或 Handoff 未指定精準 reference，會 fail-closed，需要 Master 補齊。
- 回滾只還原本次檔案差異，保留工作區原有修改。新版容器回到舊 hook 可能全部拒絕，由 Master 決定是否還原單筆格式。

- `verifyAuthorizationSnapshot` 只驗內容自洽，快照可以偽造；驗收必須用 `verifySelfAcceptance` 對照 live entry。
- 授權模組依賴 `backend/node_modules`；未安裝時 hook 載入失敗並 fail-closed，錯誤訊息會指示安裝。

本紀錄不代表 Master 安全驗收已通過。離線測試與實際模型驗收必須分開回報。

## 已執行驗證

- 2026-10-30 使用 Qwen 0.25.3 經 adapter 完成 live smoke 與一次完整審查（`review-full-2`：APPROVE，證據檢查通過），兩者都早於 Windows 啟動解析、版本檢查與 F3／F4 修改，也沒有抓到部分已知問題，不能單獨作為驗收依據。
- 未修改 frontend／bff／backend，未執行各產品套件 lint／test／build。未執行實際 Master GC、未建立 OpenSpec change，未 commit／push。Codex 調用 adapter 尚未實測。

最新的離線測試結果以完成回報為準，略過項目是 Windows 缺少建立檔案 symlink 權限；補充的 mocked realpath 越界測試不等同實體 symlink 測試。
