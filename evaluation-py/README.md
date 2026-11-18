# Chat Gun 離線評測分析

Python 3.12 + uv；import 套件為 `chat_gun_eval`。在此目錄執行：

```sh
uv sync --locked
uv run --locked chat-gun-eval --help
uv run --locked chat-gun-eval parity ../backend/data/knowledge-eval/results ../backend/data/research-eval/results
uv run --locked chat-gun-eval compare ../backend/data/knowledge-eval/results/kb-eval-v1-2026-10-27-r2/run-vector_only.json ../backend/data/knowledge-eval/results/kb-eval-v1-2026-10-27-r2/run-vector_rerank.json --output examples/kb-comparison.md
```

`parity` 與 `compare` 接受明確指定的 run 檔或目錄。目錄只尋找其本身及下一層的 `run-*.json`，每份 run 讀取同層 `provenance.json`，不搜尋 repo。輸入必要欄位／型別／封閉集合錯誤會回報檔名與欄位路徑；未知新增欄位容許。讀取模型版本為 `evaluation-analysis@1`，不要求歷史 TS 檔案補寫欄位。

比較至少兩份同類型 run，第一份是基準。datasetVersion 不同（kb 另檢查 corpusVersion）會拒絕；只有明確使用 `--allow-cross-version` 才允許，標題會標示「跨資料集版本」。報告包含 summary 全部葉節點、差異、各指標樣本數及已知 provenance 欄位；缺少欄位顯示「未記錄」，不推測模型或設定。時間只取自 provenance，沒有執行時間戳。報告不含逐題 question、answer 或 evidence。範例為同一 kb 資料集的 retrieval 策略比較，不代表統計顯著或線上產品品質。

## 指標與 parity

唯一事實來源是 `backend/src/knowledge/evaluation/{runner,scorers,stage-latency}.ts` 與 `backend/src/evaluation/research/scoring.ts`。Python 原始碼註明對應函式；不修改 TS 或評測結果。Research 會由 observations 重算 citation／refusal／clarify，再重算 summary；沒有執行 rerank／citation guard 時省略相應摘要。

- 分母、split、失敗排除、空集合 null 與 nearest-rank percentile 沿用 TS。
- 比率以絕對誤差 `1e-9` 比對，不使用相對誤差；計數、percentile 與其他數值要求完全相同。缺少欄位與 null 不同。
- 所有已錄 run 均納入 pytest 與 CI parity。`src/chat_gun_eval/exceptions.json` 是具名、綁定 SHA-256 的早期 run 例外：只允許經提交紀錄證明尚未存在的摘要欄位。舊指標仍全部比較，不能豁免整份 run、篡改的檔案或放寬誤差。新增例外必須附原因、來源提交與窄化欄位清單，經審查後才可加入。
- 比較報告展示已錄摘要；parity 是獨立的真偽檢查。發現不一致時應先調查，不應將比較報告當成已通過 parity 的證明。

## 品質門檻

```sh
uv run --locked ruff format --check .
uv run --locked ruff check .
uv run --locked mypy
uv run --locked pytest
```

GitHub Actions 的 Python workflow 以 uv.lock 安裝相依，執行以上門檻及全部已錄 parity。測試包含網路封鎖、輸入雜湊／mtime、CLI 錯誤、具名例外、deterministic 報告與中斷時保留原檔。輸出先寫入同目錄暫存檔，再原子改名；正常失敗或 KeyboardInterrupt 會清理暫存檔，且禁止覆寫所選輸入檔。

本機結果目錄內的未追蹤 run 也會納入本機檢查；CI 只能檢查 checkout 中實際存在的結果。例外清單中未出現在 checkout 的具名檔案不會套用任何豁免，既有 run 的比對不受影響。

執行相依只有 pydantic；不 import 網路／模型 SDK、不連模型、資料庫或網路、不讀環境 secret 檔。安裝 Python 或依賴可能需要下載；完成安裝後分析可離線執行。功能僅涵蓋 kb-eval 與 research-eval，不含 commerce，也不執行 live 評測或發布 Opik。
