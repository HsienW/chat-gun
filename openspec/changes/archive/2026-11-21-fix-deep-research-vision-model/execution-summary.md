# Execution Summary

## 實際完成內容與 Design 差異

PR #183 已將實作 `c8c0313` 合併到 `master_next`（`ddae205`）。深度研究使用 Gateway 為 vision 用途解析的模型處理圖片，並將本輪的結果傳給 planner、synthesis 與 Timeline。辨識失敗會留下空的圖片觀察與結構化錯誤；取消仍向上傳遞。

CCR 撤回要求主要 provider 缺席時降級的 F-2，改採 F-2'。Gateway 建立清單時必定先納入主要 provider，因此保留原有的 invariant guard 與 throw，補上註解及 fallback 開關兩種測試。此決策維持 D2 要求的實際模型 ID。F-1 將測試中的 provider 錯誤改為中性 sentinel，並驗證序列化結果不含原始細節與圖片 data URL。

## 主要修改檔案

- `openspec/specs/backend-model-runtime/spec.md` 整段更新 Vision Model Routing。
- `openspec/specs/deep-research-image-recognition/spec.md` 收錄本輪辨識結果與辨識失敗降級兩項需求。
- `openspec/specs/frontend-chat/spec.md` 新增 Timeline 顯示 backend 實際模型的需求。
- 本目錄保存原 proposal、design、tasks 與三份 delta。實作位於已合併的 backend 圖片辨識節點與 frontend runtime event adapter。

## 驗證結果

Qwen 的 review-result-04 為 APPROVE，Blocker、Major、Minor 均為零。CCR 判定 READY_TO_ARCHIVE。實作階段的 backend lint 與 build 通過；完整測試以兩個 workers 執行時有 2,604 個通過、120 個跳過。驗收階段由 CCR 重跑 frontend 測試，364 個通過；backend deep-researcher 測試 99 個通過、3 個跳過。

封存前 change 的 strict 驗證通過。封存後以 `openspec validate --all --strict --no-interactive` 驗證 91 項，全數通過。三份主規格均可解析為 JSON。

## 接受的風險與理由

Task 4.2 為選做，未使用真實 provider 與瀏覽器執行 live smoke。模型線上辨識品質與 Timeline 實際顯示仍待驗證。Windows 預設並行的 backend 全量測試曾有 9 個檔案、12 個測試失敗；以 `--maxWorkers=2` 完整重跑通過。驗收採用該次完整結果，預設並行的穩定性仍待調查。

## 未完成項目

Task 4.2 保持未勾選。建議另案評估 planner 與 synthesis 繼續使用 `reasoning_model` 對研究品質的影響；另案處理一般 chatbot 看不到圖片的問題。測試方面，建議追查預設 worker 數下的逾時與衍生斷言失敗。

## 重要決策與取捨

本次將模型路由修正限定在深度研究的圖片辨識步驟。Timeline 使用 backend 回傳的模型與固定失敗訊息，避免將 provider 原始錯誤帶入畫面。

## Commit 建議

`docs(openspec): archive deep research vision model routing`
