# 自建 runtime 公開產出清理與封存紀錄

## 實作與封存

實作 commit `f339bbc` 從 `deploy/self-hosted-runtime/` 移除 47 個一次性驗證檔案，留下 Dockerfile、Dockerfile.dockerignore、兩個啟動腳本及改寫後的 README。封存 spike 的 findings 第 61 行改為引用保存歷史工具的 commit `d4835b5`。

本次依 CCR 的獨立人工審查勾選任務 3.1，七項任務全部完成。OpenSpec 將 Change 移入日期前綴的封存目錄，並把「公開保存的 runtime 產出只含可對外內容」及四個 Scenario 加入主規格。主規格 diff 為新增 33 行、刪除 0 行。

## 驗證證據

- Codex 的 `implementation-result-001` 記錄 52 個追蹤檔的清理前基準、47 筆移除清單、四個建置與啟動檔前後一致的 SHA-256、公開標記搜尋零命中，以及 runtime、BFF 映像建置與入口檢查結果。
- CCR 的 `readiness-result-001` 記錄 README 六項必要內容及禁止內容的獨立人工審查。CCR 另核對保留檔案、公開標記、歷史工具引用與修改範圍。建置結果沿用 Codex 的實測紀錄。
- 本次以 `openspec validate --strict` 分別驗證主規格與封存 Change，兩次結束碼均為 0。

```text
Specification 'self-hosted-runtime-feasibility' is valid
Change 'archive/2026-11-20-sanitize-spike-public-artifacts' is valid
```

## 審查例外與風險接受

依 CCR 的 `coordinator-result-review-result-001`，Qwen 的 `review-result-001` 與 `review-result-002` 審查內容均為 `APPROVE`，Blocker、Major、Minor 均為 0。兩次 evidence gate 均因 `output_extraction_failed`、`reviewer_provenance_not_observed` 判為 `INCOMPLETE`。Master 於 2026-11-20 回覆「我接受風險」，以風險接受代替該 gate。任務 3.1 的勾選依據為 CCR 的人工審查。

## 後續事項

- adapter 失敗時應保存 evidence，並支援抽取 subagent 回傳的「說明文字加 JSON」格式。
- 為 Qwen review prompt 訂出固定的輸出範本。
- 由 `demo-predeploy-cost-and-packaging` 負責人更新 tasks 5.1，明列沿用的 Dockerfile 與啟動入口。

本次封存交由 Master 提交與推送。建議提交標題為 `docs(openspec): archive sanitize-spike-public-artifacts`。
