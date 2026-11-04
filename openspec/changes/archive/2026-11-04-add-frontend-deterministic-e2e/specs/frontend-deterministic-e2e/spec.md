## ADDED Requirements

### Requirement: E2E MUST 只依確定性回應執行

Frontend E2E MUST 在真實瀏覽器中執行已建置的 Frontend，並只使用預先定義的確定性回應。E2E MUST NOT 呼叫真實模型、Model Provider、Tool Provider、BFF 或 Backend 執行個體，也 MUST NOT 依賴任何憑證。

#### Scenario: 確定性回應成功

- GIVEN 一個以腳本定義的回應情境
- WHEN E2E 在相同版本的 Frontend 上重複執行該情境
- THEN 每次瀏覽器收到的串流內容與順序 MUST 相同
- AND 執行過程 MUST NOT 讀取任何模型或 Provider 憑證

#### Scenario: 未預期的請求使測試失敗

- GIVEN 一個情境只定義了特定請求
- WHEN 瀏覽器送出該情境未定義的請求
- THEN 該請求 MUST 收到明確的失敗回應
- AND 該測試 MUST 判定為失敗，MUST NOT 靜默通過

#### Scenario: 對外網路被拒絕

- GIVEN E2E 正在執行
- WHEN 頁面嘗試連到測試 origin 以外的位址
- THEN 該連線 MUST 被拒絕
- AND 該測試 MUST 判定為失敗

### Requirement: E2E 時序 MUST 由情境控制而非固定延遲

E2E MUST 以情境控制的釋放點決定回應送出時機，並以 UI 狀態或已記錄的請求作為等待條件。E2E MUST NOT 以固定時間等待作為同步手段。CI 執行 MUST NOT 自動重試失敗的測試。

#### Scenario: 以釋放點控制逐步送出

- GIVEN 一個情境把回應分成多段，每段等待測試釋放
- WHEN 測試釋放第一段
- THEN 瀏覽器 MUST 只收到第一段
- AND 在測試釋放下一段之前，fixture MUST NOT 送出後續內容

#### Scenario: 固定延遲被拒絕

- GIVEN E2E 原始碼中出現固定時間等待
- WHEN 執行 Frontend lint
- THEN lint MUST 失敗

#### Scenario: 重複執行穩定

- GIVEN 完整 E2E 套件
- WHEN 每個測試連續重複執行至少 5 次，且不允許重試
- THEN 所有執行 MUST 通過

### Requirement: 串流回覆 MUST 逐步渲染並單向收斂到 Terminal State

E2E MUST 驗證串流回覆在瀏覽器中逐步出現，並依結構化終止訊號收斂為成功、失敗或逾時，三者 MUST 可區分。

#### Scenario: 逐步渲染

- GIVEN 一則回覆分多段送出
- WHEN 只釋放前段
- THEN 畫面 MUST 顯示前段內容且仍處於串流中
- AND 釋放其餘內容後，畫面 MUST 顯示完整內容

#### Scenario: 成功完成

- GIVEN 一則回覆送出全部內容與正常結束
- WHEN 串流結束
- THEN 畫面 MUST 離開串流中狀態，輸入 MUST 可再次送出
- AND 最終回覆 MUST 只出現一次

#### Scenario: 未知事件安全降級

- GIVEN 串流中夾帶一個未知 type 的事件與一個帶未知欄位的已知事件
- WHEN 瀏覽器處理該串流
- THEN Chat UI MUST 繼續運作並完成回覆
- AND 頁面 MUST NOT 出現未處理的例外

#### Scenario: 中途失敗

- GIVEN 回覆已送出部分內容後，以結構化錯誤 frame 結束
- WHEN 瀏覽器收到該錯誤
- THEN 畫面 MUST 顯示安全的錯誤訊息，MUST NOT 顯示為成功完成
- AND 畫面 MUST NOT 出現內部錯誤細節
- AND 使用者 MUST 可送出新的訊息

#### Scenario: 逾時

- GIVEN 回覆以 `bff_timeout` 或 `upstream_timeout` 結構化錯誤碼結束
- WHEN 瀏覽器處理該錯誤
- THEN 畫面 MUST 呈現逾時語意
- AND MUST NOT 呈現為一般失敗或取消

### Requirement: 使用者取消 MUST 立即生效且不可被晚到內容推翻

E2E MUST 驗證使用者取消串流時，UI 立即反映取消、取消信號送達瀏覽器對外邊界、取消後晚到的內容不使已取消回覆恢復，且使用者可以開始新回覆。本 Requirement 的「上游」指瀏覽器對外連線的另一端；BFF 到 Backend 的傳遞不在本 Requirement 範圍。

#### Scenario: UI 立即反映取消

- GIVEN 一則回覆正在串流，且後續內容尚未釋放
- WHEN 使用者按下取消
- THEN 畫面 MUST 立即顯示已取消，MUST NOT 等待上游回應
- AND 串流中指示 MUST 消失

#### Scenario: 取消信號送達上游

- GIVEN 一則回覆正在串流
- WHEN 使用者按下取消
- THEN 原串流連線 MUST 由瀏覽器端關閉
- AND 瀏覽器 MUST 送出一次取消請求，且帶有被取消 Run 的識別

#### Scenario: 晚到內容不復活

- GIVEN 使用者已取消一則回覆
- WHEN 上游之後在串流中送出屬於該回覆的內容或終止訊號
- THEN 該回覆 MUST 維持已取消
- AND 已取消回覆的內容 MUST NOT 增加，畫面 MUST NOT 回到串流中

#### Scenario: 取消後開始新回覆

- GIVEN 使用者已取消一則回覆
- WHEN 使用者送出新訊息
- THEN 瀏覽器 MUST 送出新的請求，且只送一次
- AND 新回覆 MUST 正常串流並完成，已取消的回覆 MUST 保持不變

### Requirement: HITL 審批 MUST 以一次性 resume 送出人工決定

E2E MUST 驗證審批卡片的核准、拒絕、撤回與送出失敗行為，且每次人工決定在網路上只送出一次。

#### Scenario: 核准

- GIVEN 一筆操作處於等待審批，畫面顯示審批卡片
- WHEN 使用者按下核准
- THEN 瀏覽器 MUST 送出一次帶核准決定的 resume 請求
- AND 卡片 MUST 依上游回傳的結構化狀態更新

#### Scenario: 拒絕

- GIVEN 一筆操作處於等待審批
- WHEN 使用者按下拒絕
- THEN 瀏覽器 MUST 送出一次帶拒絕決定的 resume 請求
- AND 卡片 MUST 依上游回傳的結構化狀態顯示已拒絕

#### Scenario: 撤回

- GIVEN 一筆操作處於等待審批
- WHEN 使用者按下撤回
- THEN 瀏覽器 MUST 送出一次取消請求，並帶有該審批所屬 Run 的識別
- AND 卡片 MUST 依上游回傳的結構化狀態顯示已在生效前取消

#### Scenario: 送出失敗

- GIVEN 一筆操作處於等待審批
- WHEN 使用者送出決定，而上游回傳結構化錯誤
- THEN 卡片 MUST 保持開啟並顯示錯誤與錯誤碼
- AND 操作狀態 MUST NOT 被當作已改變
- AND 使用者 MUST 可以再次送出決定

#### Scenario: 連點只送一次

- GIVEN 一筆操作處於等待審批
- WHEN 使用者在回應前快速連點同一個或不同的決定按鈕
- THEN 瀏覽器 MUST 只送出一次 resume 或取消請求

### Requirement: 退款去重畫面 MUST 呈現去重狀態、原因與原操作狀態

E2E MUST 驗證操作卡片收到 `deduplicated` 狀態時，畫面依結構化欄位呈現去重狀態、去重原因與原操作的狀態。

#### Scenario: 原操作已知

- GIVEN 頁面上已有一筆原操作卡片，之後收到指向它的 `deduplicated` 卡片
- WHEN 畫面渲染
- THEN 去重卡片 MUST 顯示去重狀態與對應的去重原因
- AND MUST 顯示原操作目前的狀態

#### Scenario: 原操作未知

- GIVEN 收到 `deduplicated` 卡片，但它指向的原操作不在頁面上
- WHEN 畫面渲染
- THEN 去重卡片 MUST 顯示原操作狀態不可得
- AND MUST NOT 推測原操作狀態

#### Scenario: 未知操作狀態

- GIVEN 收到一張操作狀態值不在已知清單中的卡片
- WHEN 畫面渲染
- THEN 畫面 MUST 安全降級，MUST NOT 將其顯示為任何已知狀態
- AND Chat UI MUST 繼續運作

### Requirement: Clarification MUST 以一次性 resume 恢復

E2E MUST 驗證 Clarification interrupt 的候選渲染、選擇恢復與取消恢復。Frontend 只依結構化 interrupt 內容渲染，MUST NOT 自行推測地點。

#### Scenario: 選擇候選後恢復

- GIVEN 串流以帶有效 interruptId 的 Clarification interrupt 暫停，畫面顯示候選
- WHEN 使用者選擇一個候選
- THEN 瀏覽器 MUST 送出一次 resume 請求，內容只來自所選候選的結構化資料與該 interruptId
- AND 恢復後的回覆 MUST 正常完成，Clarification 控制項 MUST 消失

#### Scenario: 取消 Clarification

- GIVEN 畫面顯示 Clarification 候選
- WHEN 使用者取消 Clarification
- THEN 瀏覽器 MUST 送出一次取消 resume 請求
- AND 畫面 MUST NOT 顯示為查無資料

#### Scenario: 恢復失敗

- GIVEN 使用者已送出 Clarification 選擇
- WHEN 上游回傳結構化錯誤
- THEN 畫面 MUST 顯示安全的錯誤訊息
- AND MUST NOT 顯示為成功完成

### Requirement: 事件與提交 MUST 在瀏覽器中去重

E2E MUST 驗證重複或亂序的串流事件、過期 Run 的輸出與重複提交，只讓畫面狀態改變一次，且 Terminal State 不回退。

#### Scenario: eventId 重複

- GIVEN 串流中同一個 `eventId` 的事件送達兩次
- WHEN 畫面渲染
- THEN 對應的畫面變化 MUST 只出現一次

#### Scenario: sequence 亂序

- GIVEN 同一 Run 的事件在 reorder window 內亂序送達
- WHEN 畫面渲染
- THEN 畫面結果 MUST 與依序送達時相同

#### Scenario: 過期 Run

- GIVEN 已有 authoritative Run，之後收到另一個非 authoritative Run 的事件
- WHEN 畫面渲染
- THEN 該事件 MUST NOT 改變畫面

#### Scenario: 訊息 ID 重複

- GIVEN 串流中同一個訊息 ID 被送達多次
- WHEN 畫面渲染
- THEN 該訊息 MUST 只顯示一次

#### Scenario: Terminal 重播

- GIVEN 一個 Run 已進入 Terminal State
- WHEN 同一 Run 的 Terminal 事件或較早的進度事件再次送達
- THEN 畫面 MUST 維持原 Terminal State，MUST NOT 回到執行中

#### Scenario: 重複提交

- GIVEN 使用者已輸入訊息
- WHEN 使用者在回應前以按鍵與按鈕連續觸發送出
- THEN 瀏覽器 MUST 只送出一次 run 請求
- AND 畫面 MUST 只出現一則使用者訊息

### Requirement: E2E MUST 在 CI 執行且不影響既有驗證

E2E MUST 在 Frontend 變更的 Pull Request 上自動執行；任一測試失敗 MUST 使 CI 失敗。E2E MUST NOT 被既有 unit test 指令收入，也 MUST NOT 改變既有 lint、test、build 的結果。

#### Scenario: CI 執行成功

- GIVEN 一個修改 Frontend 的 Pull Request
- WHEN CI 執行
- THEN E2E MUST 執行並回報結果

#### Scenario: CI 失敗

- GIVEN 任一 E2E 測試失敗
- WHEN CI 執行
- THEN CI job MUST 失敗，MUST NOT 因重試而轉為通過
- AND 失敗的追蹤資料 MUST 上傳為 CI artifact，且 MUST NOT 含有憑證

#### Scenario: CI 逾時或取消

- GIVEN E2E job 超過 job 時間上限或被取消
- WHEN CI 結束
- THEN 該 job MUST 標示為失敗或取消，MUST NOT 標示為通過

#### Scenario: 既有驗證不受影響

- GIVEN 本 Change 已套用
- WHEN 執行 Frontend 的 lint、unit test 與 build
- THEN 三者 MUST 通過
- AND unit test MUST NOT 執行任何 E2E 檔案
