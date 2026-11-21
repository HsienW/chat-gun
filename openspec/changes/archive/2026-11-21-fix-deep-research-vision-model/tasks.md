## 1. 固化失敗案例（先證明問題）

- [x] 1.1 新增 backend 確定性失敗測試：以 fake provider 執行 `deep_researcher` 圖片辨識節點，`reasoning_model` 為 `qwen-plus`、vision 專屬與 legacy 設定皆未設定、使用者訊息含一張圖片；斷言送出的 vision 請求模型為 `qwen3.5-flash` 且含 `image_url` part。修正前此測試 MUST 失敗並記錄失敗輸出。對應：backend-model-runtime「使用者選擇的模型不影響圖片辨識」。
- [x] 1.2 新增 backend 確定性失敗測試：vision 請求丟出 provider 錯誤時，斷言圖片觀察內容為空，且圖片辨識結果為失敗。修正前 MUST 失敗並記錄。對應：deep-research-image-recognition「provider 回傳錯誤」。

驗證：`cd backend && npm run test`（記錄 1.1、1.2 修正前失敗輸出）

## 2. Backend：模型解析與圖片辨識結果

- [x] 2.1 圖片辨識節點建立 vision 模型時不再傳入 `reasoning_model`；實際 provider／模型 id 以已匯出的 `enabledChatModels([{ purpose: "vision" }])` 取得，條件與建立模型時一致（不傳呼叫端模型），不匯出 `resolveProviderModel`，不新增依模型名稱的判斷。測試 MUST 斷言結果中的模型 id 等於實際送出請求的模型。對應：backend-model-runtime 全部 Scenario（含 vision 專屬設定優先）。
- [x] 2.2 新增可序列化的圖片辨識結果 State 欄位（成功／失敗、provider、model、imageCount、失敗時的 ErrorEnvelope），每個新 turn 清除；舊 checkpoint 缺欄位時視為不存在。對應：deep-research-image-recognition 第一個 Requirement 全部 Scenario。
- [x] 2.3 失敗、空回應、逾時改為失敗結果，不再寫入圖片觀察內容；取消（signal aborted／AbortError）重新拋出，不寫入失敗結果。對應：deep-research-image-recognition 第二個 Requirement 全部 Scenario；backend-model-runtime「圖片辨識逾時」「圖片辨識被取消」。
- [x] 2.4 研究規劃與最終回答依圖片辨識結果組裝圖片證據：成功沿用觀察內容；失敗改為固定的「圖片辨識失敗，不得猜測圖片內容，需告知使用者」說明，不含 ErrorEnvelope 原文；沒有圖片沿用既有文字。對應：deep-research-image-recognition「provider 回傳錯誤」。
- [x] 2.5 補齊測試：成功（模型 id、圖片數量）、無圖片不呼叫 vision、上一輪不殘留、舊 checkpoint、vision 專屬設定優先、空回應、逾時、取消、ErrorEnvelope 不含 data URL／金鑰。並確認 1.1、1.2 由失敗轉為通過。

驗證：
```bash
cd backend
npm run lint
npm run test
npm run build
```

## 3. Frontend：Timeline 顯示實際看圖模型

- [x] 3.1 runtime event node keys 新增 `analyze_images`，node adapter 依圖片辨識結果產生既有 `agent.tool.success`／`agent.tool.error` 形狀的活動項目，模型 id 取自 backend 回傳值，不寫死模型名稱。對應：frontend-chat「圖片辨識活動 MUST 顯示 backend 回傳的實際模型」。
- [x] 3.2 擴充 runtime event 處理與 runtime event labels：圖片辨識活動顯示專屬文案「圖片辨識完成（模型：{model}）」／「圖片辨識失敗（模型：{model}）」，依結構化欄位辨識，不依顯示文字；其他工具的「工具完成／工具錯誤」文案不變。失敗時 adapter MUST NOT 讀取或顯示 backend 的 ErrorEnvelope 字串，改用 labels 中的固定安全訊息。
- [x] 3.3 單元測試：成功顯示 `qwen3.5-flash`、選單為 `qwen-plus` 時仍顯示 backend 值、失敗顯示失敗與模型且不含 ErrorEnvelope 內容（以含 provider 錯誤文字的 fixture 斷言畫面不出現該文字）、其他工具文案不變、缺欄位或格式不符時略過且同 update 其他事件照常顯示。

驗證：
```bash
cd frontend
npm run lint
npm run test
npm run build
```

## 4. 回歸與 live 驗證

- [x] 4.1 執行 backend 既有 `deep_researcher` 回歸（天氣、query workflow、answer stream、turn evidence）與 frontend 既有 runtime event、answer stream 測試，全部通過。
- [ ] 4.2 （選做，需明確旗標）以 live 環境用同一張圖與同一句問題執行深度研究，記錄實際 vision 模型 id、回答是否描述圖片內容、Timeline 顯示；未執行時在 implementation_result 標為未驗證。
