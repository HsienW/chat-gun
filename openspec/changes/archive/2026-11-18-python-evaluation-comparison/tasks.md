## 0. 前置 Gate

- [x] 0.1 Qwen 完成 review-plan，Blocker 清零，Major 已修正或有明確接受理由。驗證：`review-result-review-plan-001` 由 adapter 保存且 evidence gate 通過（APPROVE，0 Blocker／0 Major／2 Minor），CCR 仲裁紀錄寫入 design。
- [x] 0.2 Master 定案 design OD-1 至 OD-3 並寫回 design。驗證：design 不再有未定案的 OD；`openspec validate python-evaluation-comparison --strict` 通過。（2026-11-17：OD-1～3 已定案並寫回 design；Master 執行 validate --strict 回報通過。）

範圍限制：MUST NOT 修改 `frontend/**`、`bff/**`、`backend/**`（含既有評測結果檔）、其他 Change 的檔案或規格；MUST NOT 新增任何網路或模型 SDK 相依；MUST NOT 讀取 `.env*`。

## 1. 套件骨架

- [x] 1.1 依 OD-1、OD-2 於 `evaluation-py/` 建立 Python 3.12 套件 `chat_gun_eval`（uv 管理、提交 `uv.lock`）：專案設定、鎖定檔、formatter／linter、strict 型別檢查、pytest 設定，以及 CLI 進入點（`parity`、`compare` 兩個子命令）。對應 Requirement：「Python 元件有獨立 CI 驗證」。驗證：在套件目錄執行 lint、型別檢查與 pytest 皆 exit 0；新增測試斷言相依清單不含網路或模型 SDK。

## 2. 輸入模型

- [x] 2.1 以 pydantic 定義 kb-eval run、research-eval run、provenance 的模型與封閉集合常數（單一來源）；容許未知欄位，必要欄位缺失、型別錯誤、未知 enum 值時失敗並附檔案與欄位路徑。對應 Requirement：「評測產出以版本化模型做 Runtime Validation」。驗證：pytest 涵蓋合法 run、必要欄位缺失、型別錯誤、未知 split、未知新增欄位；讀取前後輸入檔雜湊相同。

## 3. 摘要一致性

- [x] 3.1 kb-eval 摘要重算：逐一對照 `backend/src/knowledge/evaluation/` 的 TS 定義（含 split 分組、分母、空集合、percentile），在 Python 原始碼註明對應的 TS 函式。對應 Requirement：「重算摘要必須與 TS 摘要一致」。驗證：pytest 對 `backend/data/knowledge-eval/results/` 全部 run 執行 parity 通過；竄改 summary 的 fixture 失敗並輸出 split、指標、TS 值、Python 值；空集合案例與 TS 處理一致。
- [x] 3.2 research-eval 摘要重算：依 OD-3 以 im-agent 移植為起點（im-agent 唯讀，不修改、不切分支），逐項對照 `backend/src/evaluation/research/scoring.ts`。對應 Requirement：同上。驗證：pytest 對 `backend/data/research-eval/results/` 全部 run 執行 parity 通過；竄改 fixture 失敗；無 rerank 與無 citation guard 的 run 欄位集合與 TS 相同。
- [x] 3.3 若有早期 run 無法一致，建立具名例外清單並逐項寫明原因（例如當時 scorer 版本），不得放寬容許誤差。驗證：例外清單有測試；清單為空時本項直接勾選並註明「無例外」。

## 4. 比較報告

- [x] 4.1 實作 `compare`：至少兩個 run、同評測類型；資料集版本不同時拒絕，除非明確允許並在標題標示；provenance 對照（缺少欄位顯示「未記錄」）；各指標各 split 數值、相對基準 run 的差異、樣本數、小樣本提醒；不輸出逐題全文。對應 Requirement：「跨 run 比較報告」。驗證：pytest 涵蓋模型比較、資料集版本不同、舊 provenance、只給一個 run；報告不含 fixture 中的 question／answer 字串。
- [x] 4.2 deterministic 與原子輸出：固定排序與小數位、不含執行時間戳；暫存檔加原子改名；模擬中斷不留下半份報告且既有檔案不變。對應 Requirement：「離線、deterministic 與原子輸出」。驗證：連續兩次輸出位元組相同的測試；中斷模擬測試；在停用網路的環境（例如以 socket 封鎖的測試 fixture）執行 parity 與 compare 皆成功。
- [x] 4.3 以 kb-eval 已錄的 `kb-eval-v1-2026-10-27-r2` 的 `vector_only` 與 `vector_rerank` 產生一份範例比較報告，放在套件的範例目錄。驗證：報告由 CLI 產生，檔案內容與重跑結果相同。

## 5. CI 與文件

- [x] 5.1 新增 GitHub Actions workflow：在 Python 套件或 `backend/data/{knowledge-eval,research-eval}/results/**` 變更時觸發，執行 lint、型別檢查、pytest 與全部已錄 run 的 parity。對應 Requirement：「Python 元件有獨立 CI 驗證」。驗證：本機以等價命令執行通過；workflow 語法檢查通過；在 implementation_result 記錄 CI 尚未在 GitHub 上實際執行（需推送後確認）。
- [x] 5.2 套件 README：用途、安裝、兩個子命令、指標定義以 TS 為準的說明、容許誤差與例外清單規則、限制（不含 commerce、不執行 live 評測）。驗證：README 中的命令都實際執行過一次。

## 6. 整體驗證

- [x] 6.1 `git diff --stat` 只包含 Python 套件目錄、workflow 與本 Change 的 OpenSpec 檔案；既有評測結果檔雜湊不變；`openspec validate python-evaluation-comparison --strict` 通過。
