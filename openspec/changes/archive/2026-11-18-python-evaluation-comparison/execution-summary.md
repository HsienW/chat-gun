# Execution Summary

## 實際完成內容與 Design 差異
依 handoff-archive-change-001 封存 python-evaluation-comparison。delta 的 5 個 Requirement 與全部 Scenario 合併為主規格；原始 proposal、design、tasks、delta spec 位元組不變，tasks 13 項維持勾選。封存未變更產品實作或核准設計。

## 主要修改檔案
- 主規格：openspec/specs/python-evaluation-analysis/spec.md
- Change 移至：openspec/changes/archive/2026-11-18-python-evaluation-comparison/
- 封存結果與命令原始輸出：.agent-runtime/python-evaluation-comparison/artifacts/archive-result.json、.agent-runtime/python-evaluation-comparison/evidence/archive-change-001/

## 驗證結果
- `openspec validate python-evaluation-comparison --strict --no-interactive`：exit 0；輸出 .agent-runtime/python-evaluation-comparison/evidence/archive-change-001/validate-before.log
- `openspec archive python-evaluation-comparison --yes`：exit 0；輸出 .agent-runtime/python-evaluation-comparison/evidence/archive-change-001/archive.log
- `openspec validate python-evaluation-analysis --type spec --strict --no-interactive`：exit 0；輸出 .agent-runtime/python-evaluation-comparison/evidence/archive-change-001/validate-after.log
- `uv run --locked pytest`：exit 0；輸出 .agent-runtime/python-evaluation-comparison/evidence/archive-change-001/pytest-after.log
- `uv run --locked chat-gun-eval parity ../backend/data/knowledge-eval/results ../backend/data/research-eval/results`：exit 0；輸出 .agent-runtime/python-evaluation-comparison/evidence/archive-change-001/parity-after.log
封存前後 Requirement 文字相同；21 個產品／workflow 檔案的大小與修改時間不變；其他未提交檔案的 Git 狀態未變。pytest 與 parity 的具體統計以本輪原始日誌為準。

## 接受的風險與理由
- 沿用 CCR readiness 紀錄：Python CI 尚未在 GitHub Ubuntu runner 實際執行。 推送後確認 Python evaluation analysis workflow 綠燈；失敗時以 fix-from-review 交 Codex。
- 沿用 CCR readiness 紀錄：kb-eval-v1-2026-10-27/ 兩份 run 在本機未被 Git 追蹤，CI 只會檢查 10 份已追蹤 run。 該目錄不屬本 Change 範圍；是否提交由 Master 另行決定，parity 的例外機制對缺檔不會誤報。
- 沿用 CCR readiness 紀錄：normalize_url 與 TS URL 建構子在 userinfo 與 query 百分號編碼上有邊緣差異，fixture 未涵蓋。 實際發生時 parity 會因 citationPrecision 不一致而失敗並列出指標；可日後補 fixture。
- 沿用 CCR readiness 紀錄：im-agent feat/python-research-agent 分支本機不存在，只以 feat/research-eval-metrics 移植。 移植後以 chat-gun TS 為準逐項核對，research 3 份 run parity 通過。
9 份歷史 KB run 仍採 SHA-256 綁定的窄化欄位缺漏例外，不放寬 1e-9 比率誤差；本輪 parity 會明確列示。

## 未完成項目
- GitHub Actions／Ubuntu runner 需 Master 推送後確認；本輪未執行。
- 本輪未重跑 lint、mypy 與 wheel build，沿用 CCR readiness 已接受的實作證據。
- Git commit／push 由 Human 自行執行；本輪未操作。

## 重要決策與取捨
Python 元件維持離線分析；TS scorer 為唯一指標定義。採用 CCR 的獨立 readiness（與 producer Codex 不同），本輪只做封存後回歸驗證。

## Commit 建議
`feat(evaluation): add offline Python evaluation comparison`
請只挑選本 Change 的 Python 套件、workflow、封存目錄與主規格；其他 Change 與既有未追蹤評測資料由 Master 另行決定。
