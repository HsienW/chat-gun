## ADDED Requirements

### Requirement: 深度研究最終答案串流

深度研究在功能啟用且端點能力支援時，最終研究答案 MUST 於模型生成期間逐段顯示於回答泡泡。不經模型產生的回覆（上傳錯誤、澄清、天氣、工具錯誤回覆）MUST NOT 建立正文串流。研究答案的後處理結果 MUST 以與草稿相同的訊息身分提交為權威終稿。

#### Scenario: 研究答案首段在生成期間可見

- GIVEN 深度研究已完成搜尋與驗證，正在合成最終答案
- AND 上游送出第一段可見正文後暫停
- WHEN 使用者查看聊天畫面
- THEN 第一段正文 MUST 已顯示於回答泡泡
- AND 活動時間軸 MUST NOT 顯示串流中的正文片段

#### Scenario: 引用防護後以終稿取代草稿

- GIVEN 研究答案已逐段顯示，且其中含有引用防護會刪除的引用
- WHEN 引用防護完成並提交終稿
- THEN 回答泡泡 MUST 改顯示防護後的終稿內容
- AND 重新載入後歷史 MUST 只含防護後的終稿
- AND 終稿的訊息身分 MUST 等於草稿的訊息身分
- AND 活動時間軸既有的「最終回答」項目若顯示終稿內容，MUST 為防護後的終稿

#### Scenario: 不經模型的分支不串流

- GIVEN 深度研究以澄清、天氣、上傳錯誤或工具錯誤回覆結束
- WHEN 節點產生回覆
- THEN 系統 MUST NOT 建立正文串流
- AND MUST NOT 記錄正文串流降級原因

### Requirement: 購物政策回答以欄位投影串流

購物助理的政策回答在功能啟用且端點支援結構化輸出串流時，MUST 於模型生成期間逐段顯示回答文字欄位的內容。放棄回答、引用無法驗證或回答無法解析時，系統 MUST 以與草稿相同的訊息身分提交既有的固定回覆，取代已顯示的草稿。結構化輸出中回答文字欄位以外的內容 MUST NOT 成為正文。

#### Scenario: 驗證通過的政策回答

- GIVEN 政策回答已逐段顯示回答文字
- WHEN 回答完成且引用驗證通過
- THEN 終稿內容 MUST 等於已顯示的回答文字
- AND 歷史 MUST 只有一則該回答

#### Scenario: 引用無法驗證時收回草稿

- GIVEN 政策回答已逐段顯示回答文字
- WHEN 回答完成但引用無法驗證
- THEN 同一回答泡泡 MUST 改顯示既有的無法驗證回覆
- AND 重新載入後歷史 MUST NOT 含被收回的回答文字

#### Scenario: 放棄回答或無法解析

- GIVEN 政策回答串流期間已顯示部分內容，或尚未顯示任何內容
- WHEN 模型放棄回答，或輸出無法解析為合法政策回答
- THEN 系統 MUST 以相同訊息身分提交對應的固定回覆
- AND 前端 MUST 以該回覆取代草稿

#### Scenario: 非回答欄位不成為正文

- GIVEN 模型輸出含 `abstained` 欄位、JSON 標點與回答文字欄位
- WHEN 系統串流該回應
- THEN 只有回答文字欄位解碼後的文字 MUST 成為正文
- AND `abstained` 的值、鍵名與 JSON 標點 MUST NOT 出現在草稿中

#### Scenario: 合成前結束的分支不串流

- GIVEN 知識查詢失敗或沒有找到來源
- WHEN 政策回答節點產生回覆
- THEN 系統 MUST NOT 建立正文串流

### Requirement: 結構化輸出的欄位投影解碼

以結構化輸出串流單一字串欄位時，系統 MUST 只投影頂層物件中第一次出現的指定欄位，並以解碼後的文字作為正文。跳脫序列 MUST 於完整後才解碼；被拆開的 surrogate pair MUST 配對後才發布。指定欄位不是字串、或 JSON 結構不合預期時，MUST 停止投影並記錄可觀察事件，MUST NOT 發布非字串內容或中斷計量。投影 MUST NOT 與工具綁定並用；與結構化輸出並用時 MUST 明確指定投影欄位；指定投影欄位時 MUST 同時要求 JSON 物件結構化輸出；任一條件不符 MUST 於呼叫前拋出可分類的設定錯誤。

#### Scenario: 跳脫序列與 surrogate 跨片段

- GIVEN 回答文字欄位含 `\"`、`\n` 與以 `😀` 表示的 emoji
- AND 上游 chunk 在跳脫序列與 surrogate pair 中間切開
- WHEN 系統投影該欄位
- THEN 正文 MUST 等於解碼後的文字
- AND 文字偏移 MUST 以解碼後文字的 UTF-16 code unit 計算

#### Scenario: 巢狀與重複的同名鍵

- GIVEN 回應在巢狀物件中，或在頂層第二次出現與指定欄位同名的鍵
- WHEN 系統投影
- THEN 這些值 MUST NOT 成為正文

#### Scenario: 指定欄位不是字串

- GIVEN 回應中指定欄位的值是數字、布林、物件或陣列
- WHEN 系統投影
- THEN 系統 MUST NOT 發布任何正文
- AND MUST 記錄投影停止事件

#### Scenario: 結構化輸出未指定投影

- GIVEN 呼叫端同時要求結構化輸出與正文串流，但未指定投影欄位
- WHEN 發起模型呼叫
- THEN 系統 MUST 於送出請求前拋出可分類的設定錯誤

#### Scenario: 指定投影但未要求結構化輸出

- GIVEN 呼叫端要求正文串流並指定投影欄位
- AND 未要求結構化輸出，或要求的結構化輸出不是 JSON 物件
- WHEN 發起模型呼叫
- THEN 系統 MUST 於送出請求前拋出可分類的設定錯誤
- AND MUST NOT 忽略投影或靜默改為整段回覆

#### Scenario: 端點不支援結構化輸出串流

- GIVEN 端點未宣告支援結構化輸出串流
- WHEN 政策回答以欄位投影發起呼叫
- THEN 系統 MUST 於呼叫前選用整段回覆
- AND MUST 記錄降級原因 `capability_unsupported`

### Requirement: 領域終稿取代與錯誤碼分工

接上正文串流的節點，於正文發布後因連線中斷、逾時或 writer 失敗而結束時，MUST 以 `answer_stream_interrupted` 錯誤碼結束；因內容過濾結束時 MUST 以 `answer_stream_refused` 結束。這兩種情況 MUST NOT 被節點既有的 fallback 回覆取代。領域後處理（引用防護、引用驗證、放棄回答、解析失敗）的結果 MUST 以相同訊息身分的權威終稿呈現。終稿 MUST 以建構時即帶有訊息身分與最終內容的訊息提交，序列化後 MUST 保留兩者。

#### Scenario: 發布後中斷不落入 fallback

- GIVEN 深度研究或政策回答已發布部分正文
- WHEN 上游連線中斷
- THEN 系統 MUST 以 `answer_stream_interrupted` 結束本次回答
- AND MUST NOT 提交 `Research synthesis failed` 或政策回答無法使用的固定回覆
- AND 前端 MUST 保留已顯示片段並標記中斷

#### Scenario: 發布後拒答

- GIVEN 深度研究或政策回答已發布部分正文
- WHEN 上游以內容過濾結束
- THEN 系統 MUST 以 `answer_stream_refused` 結束
- AND 前端 MUST 收回片段並顯示拒答提示

#### Scenario: 終稿序列化保留身分與內容

- GIVEN 節點提交了經後處理的終稿
- WHEN 終稿寫入對話狀態並序列化
- THEN 序列化結果 MUST 含草稿的訊息身分
- AND MUST 含後處理後的最終內容，MUST NOT 含後處理前的內容

### Requirement: 所有串流回答節點必須接線

功能啟用時，readiness MUST 確認一般聊天、深度研究與購物助理三個 graph 的回答節點皆已以可信執行環境與共用序號配置器接線；任一缺失 MUST 回報失敗。

#### Scenario: 任一 graph 未接線

- GIVEN 正文串流功能已啟用
- AND 深度研究或購物助理的回答節點未登記接線
- WHEN 執行 readiness 檢查
- THEN readiness MUST 回報失敗並帶出接線缺失原因
