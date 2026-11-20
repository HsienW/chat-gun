# chat-answer-text-streaming Specification

## Purpose

定義回答正文（一般聊天、深度研究最終答案、購物政策回答）在模型生成期間的逐段顯示、權威終稿對帳與領域終稿取代、重試與逾時邊界、取消與拒答、斷線政策、串流與結構化欄位投影解碼、降級、接線 readiness 及用量計量契約。
## Requirements
### Requirement: 生成期間顯示首段正文

一般聊天在功能啟用且端點能力支援時，MUST 於模型仍在生成、上游連線仍開啟時，在聊天泡泡顯示第一段可見正文。後續片段 MUST 接續更新同一則展示訊息。

#### Scenario: 上游暫停時首段已可見

- GIVEN 一般聊天已啟用正文串流且端點宣告支援
- AND 上游送出第一段可見正文後暫停
- WHEN 使用者查看聊天畫面
- THEN 第一段正文 MUST 已顯示於回答泡泡
- AND 使用者 MUST 仍可取消本次回覆
- AND 第二段正文 MUST 尚未出現

#### Scenario: 後續片段接續同一泡泡

- GIVEN 第一段正文已顯示
- WHEN 上游送出第二段正文
- THEN 第二段 MUST 接在第一段之後顯示於同一個泡泡
- AND MUST NOT 產生第二個回答泡泡

#### Scenario: 其他事件插入不延遲正文

- GIVEN 兩段正文之間有另一個屬於同一 Run 的非正文事件，且該事件晚於正文抵達
- WHEN 正文片段先抵達瀏覽器
- THEN 正文 MUST 立即顯示
- AND MUST NOT 等待該非正文事件抵達

### Requirement: 完成後只保留一則權威回答

模型呼叫成功後，系統 MUST 以與暫時正文相同的訊息身分提交一則完整回答，作為歷史與下一輪輸入。暫時正文 MUST NOT 逐段寫入對話狀態。

#### Scenario: 重新載入後只有一則回答

- GIVEN 一次串流回答已成功完成
- WHEN 使用者重新載入對話
- THEN 歷史中 MUST 只有一則該回答
- AND 其內容 MUST 等於串流期間已接受的完整正文

#### Scenario: 終稿先於最後片段抵達

- GIVEN 權威回答已抵達前端
- WHEN 同一訊息身分的晚到片段抵達
- THEN 晚到片段 MUST NOT 改變已顯示的權威內容

#### Scenario: 重複與亂序片段

- GIVEN 同一片段被重複交付，或片段亂序抵達
- WHEN 前端套用正文
- THEN 重複片段 MUST 只套用一次
- AND 正文 MUST 依其在訊息中的位置接合，MUST NOT 把後段接在錯誤位置
- AND 缺段超過有界等待時 MUST 保留可證明的前綴並等待權威回答

### Requirement: 正文發布後禁止透明重試

一旦任何正文片段已發布給使用者，系統 MUST NOT 對同一次回答進行自動重試、修復重送或切換 Provider。之後的失敗 MUST 成為不可重試、不可 fallback 的可分類錯誤。

#### Scenario: 發布後上游失敗

- GIVEN 第一段正文已發布
- WHEN 上游連線中斷或回傳格式錯誤
- THEN 系統 MUST NOT 自動重試或切換 Provider
- AND MUST 以可分類錯誤 `answer_stream_interrupted` 結束本次回答
- AND 前端 MUST 保留已顯示片段並標記中斷

#### Scenario: 首段前暫時失敗

- GIVEN 尚未發布任何正文
- WHEN 上游發生既有政策允許重試的暫時失敗
- THEN 系統 MAY 依既有政策有限重試或 fallback
- AND 重試 MUST 受首段逾時與總時限約束

#### Scenario: 落敗嘗試的晚到片段

- GIVEN 某次上游嘗試已因逾時或取消而結束
- WHEN 該嘗試仍產生正文片段
- THEN 該片段 MUST NOT 發布給使用者
- AND 丟棄 MUST 可觀察

### Requirement: 串流逾時

串流回答 MUST 分別受首段逾時、片段間閒置逾時與總時限約束。心跳或非正文框 MUST NOT 重設閒置計時或展延總時限。逾時 MUST 中止上游讀取。

#### Scenario: 首段逾時

- GIVEN 上游在首段逾時內未送出任何可見正文
- WHEN 首段逾時到期
- THEN 系統 MUST 中止該次上游嘗試
- AND 未發布正文時 MAY 依既有政策重試或 fallback

#### Scenario: 片段間停滯

- GIVEN 已發布正文，且上游只持續送出心跳
- WHEN 閒置逾時到期
- THEN 系統 MUST 中止上游並以可分類錯誤結束
- AND 使用者 MUST 看到逾時標記與已顯示片段

#### Scenario: 長回答不被既有總呼叫時限切斷

- GIVEN 上游持續穩定送出正文，總耗時超過既有單一 Provider 呼叫時限但未超過串流總時限
- WHEN 回答繼續生成
- THEN 系統 MUST NOT 因既有單一 Provider 呼叫時限而中止

### Requirement: 取消與 Run 取代

使用者取消、切換對話或新 Run 取代舊 Run 時，系統 MUST 立即停止追加正文並中止上游。晚到片段、終稿或舊 generation MUST NOT 寫入新的回答泡泡。

#### Scenario: 使用者取消

- GIVEN 正文串流進行中
- WHEN 使用者取消
- THEN 畫面 MUST 立即停止追加正文
- AND 取消 MUST 傳遞至上游
- AND 取消確認失敗 MUST 對使用者可見

#### Scenario: 新 Run 取代舊 Run

- GIVEN 舊 Run 仍有片段在途中
- WHEN 新 Run 成為權威 Run
- THEN 舊 Run 的片段 MUST NOT 寫入新 Run 的回答泡泡

### Requirement: 依 application profile 的斷線恢復

瀏覽器斷線或重新整理後，恢復行為 MUST 依 application profile 的斷線政策決定，MUST NOT 對已取消的 Run 提供重新同步。

#### Scenario: 完整 profile 斷線後 Run 繼續

- GIVEN 完整 profile 的斷線政策允許 Run 繼續
- WHEN 使用者重新載入
- THEN 系統 MUST 讀取對話狀態對帳
- AND MUST 顯示終稿，或在仍未完成時顯示處理中狀態
- AND MUST NOT 自動重新生成

#### Scenario: demo profile 斷線即取消

- GIVEN demo profile 斷線即取消 Run
- WHEN 使用者重新載入或連線中斷
- THEN 系統 MUST 顯示「已中斷」並保留已顯示片段
- AND MUST 只提供由使用者明確觸發的重新生成（新 Run）

### Requirement: 串流途中拒答

上游於串流途中以內容過濾等原因拒答時，系統 MUST 以可分類錯誤 `answer_stream_refused` 結束，且使用者 MUST 能分辨「被拒答」與「連線中斷」。已顯示的片段 MUST 被收回並改顯示拒答提示，且 MUST NOT 寫入對話歷史或成為下一輪輸入。需終稿審核才能揭露正文的端點 MUST NOT 串流。

#### Scenario: 已發布後拒答

- GIVEN 已發布部分正文
- WHEN 上游以內容過濾結束
- THEN 系統 MUST 以 `answer_stream_refused` 結束本次回答
- AND 同一回答泡泡 MUST 移除已顯示片段，改顯示拒答提示
- AND 拒答提示 MUST 由錯誤碼產生，MUST NOT 依顯示文字判斷狀態
- AND 系統 MUST NOT 提交含該片段的回答訊息

#### Scenario: 拒答後重新載入

- GIVEN 一次回答已因 `answer_stream_refused` 結束
- WHEN 使用者重新載入對話
- THEN 歷史 MUST NOT 含被收回的片段
- AND 使用者 MUST 仍能辨識該次回答被拒答

#### Scenario: 拒答與中斷可分辨

- GIVEN 一次回答因拒答結束，另一次因連線中斷結束
- WHEN 使用者查看兩則回答
- THEN 拒答的回答 MUST 不顯示片段並顯示拒答提示
- AND 中斷的回答 MUST 保留已顯示片段並標記中斷

#### Scenario: 需終稿審核的端點

- GIVEN 端點宣告需終稿審核才能揭露正文
- WHEN 一般聊天發起回答
- THEN 系統 MUST 於呼叫前選用整段回覆
- AND MUST 記錄降級原因 `final_moderation_required`

### Requirement: 能力判斷與可觀察降級

是否串流 MUST 由端點能力、用途與發布設定決定，MUST NOT 依模型名稱或回答內容判斷。不串流時 MUST 選用既有整段回覆並記錄封閉分類的降級原因。功能啟用但必要接線缺失時，readiness MUST 回報失敗。

#### Scenario: 能力不支援

- GIVEN 端點未宣告支援正文串流
- WHEN 一般聊天發起回答
- THEN 系統 MUST 選用整段回覆並完成對話
- AND MUST 記錄降級原因 `capability_unsupported`
- AND 該次執行 MUST NOT 計入串流驗收

#### Scenario: 功能啟用但接線缺失

- GIVEN 正文串流功能已啟用
- AND 回答節點無法取得可信執行環境或串流寫入通道
- WHEN 執行 readiness 檢查
- THEN readiness MUST 回報失敗
- AND MUST NOT 只在每個請求靜默降級

#### Scenario: 宣告支援卻回錯誤格式

- GIVEN 端點宣告支援串流
- WHEN 回應不是合法串流，也不是合法整包回應
- THEN 系統 MUST 回報協定錯誤
- AND MUST NOT 把未驗證內容當作正文顯示

### Requirement: 串流解碼完整性

Provider 串流 MUST 以完整事件框為單位解碼與驗證，正確處理跨 chunk 的多位元組字元與被拆開的 surrogate pair。只有已驗證的公開文字欄位能成為正文；推理內容、工具參數與 usage MUST NOT 成為正文。

#### Scenario: 跨 chunk 切分

- GIVEN 同一組上游回應被切在任意 byte 邊界（含半個中文字、半個 JSON、跳脫引號、同 chunk 多框）
- WHEN 系統解碼
- THEN 已接受的正文 MUST 與不切分時完全相同

#### Scenario: emoji 被拆成兩個框

- GIVEN 一個 emoji 的高低位 surrogate 分屬兩個上游框
- WHEN 系統發布正文
- THEN 使用者 MUST NOT 看到替代字元或半個字元

#### Scenario: 截斷與非法框

- GIVEN 上游框在連線結束時被截斷，或完整框內為非法 JSON
- WHEN 系統解碼
- THEN MUST 分別回報不完整與協定解析失敗
- AND MUST NOT 以空片段或連線結束本身判定成功

#### Scenario: 推理內容不外洩

- GIVEN 上游同時送出推理內容與正文
- WHEN 系統發布正文
- THEN 只有正文 MUST 顯示給使用者

### Requirement: 串流計量

每次實際上游嘗試 MUST 恰好計量一次。端點支援串流 usage 時 MUST 請求之；缺少 usage 時 MUST 依缺值政策記錄並標示原因。

#### Scenario: 中途中止

- GIVEN 上游嘗試在送出 usage 前被中止
- WHEN 該嘗試結束
- THEN MUST 記錄一次計量，token 為缺值並標示 `stream_aborted`

#### Scenario: 正常完成

- GIVEN 上游於結束前送出 usage
- WHEN 該嘗試結束
- THEN MUST 以該 usage 記錄一次計量
- AND MUST NOT 重複記錄

### Requirement: 正文不重複呈現於活動面板

開啟活動時間軸的 agent MUST NOT 在活動面板重複顯示正文片段。

#### Scenario: 時間軸開啟

- GIVEN agent 開啟活動時間軸
- WHEN 正文片段抵達
- THEN 正文 MUST 只出現在回答泡泡
- AND 活動面板 MUST NOT 顯示同一正文

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

