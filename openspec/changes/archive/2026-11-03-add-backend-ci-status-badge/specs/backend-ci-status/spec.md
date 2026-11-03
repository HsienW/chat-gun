## ADDED Requirements

### Requirement: Backend 驗證的觸發範圍

系統 MUST 在每個 Pull Request、預設分支的每次 push 與手動觸發時執行 backend 驗證。Pull Request 的觸發 MUST NOT 依變更路徑過濾。非預設分支的 push MUST NOT 單獨觸發驗證。

#### Scenario: 任意路徑的 Pull Request 觸發驗證

- GIVEN 一個只修改 backend 以外路徑的 Pull Request
- WHEN Pull Request 建立或更新
- THEN 系統 MUST 執行 backend 驗證
- AND Pull Request MUST 顯示該次驗證的結果

#### Scenario: 預設分支 push 觸發驗證

- GIVEN 一個提交被 push 到預設分支
- WHEN push 完成
- THEN 系統 MUST 以 push 事件執行 backend 驗證

#### Scenario: 非預設分支 push 不單獨觸發

- GIVEN 一個提交被 push 到沒有開啟 Pull Request 的非預設分支
- WHEN push 完成
- THEN 系統 MUST NOT 因該 push 執行 backend 驗證

### Requirement: 驗證步驟與結果傳遞

Backend 驗證 MUST 依序執行安裝、lint、預設測試與 build，每項都是可獨立辨識的步驟。任一步驟的非零結束 MUST 使整次驗證失敗。系統 MUST NOT 以忽略結束碼、允許失敗或略過安裝腳本的方式改變結果。

#### Scenario: 全部步驟通過

- GIVEN backend 的安裝、lint、預設測試與 build 都會成功
- WHEN 驗證執行
- THEN 四個步驟 MUST 依序執行且各自顯示成功
- AND 整次驗證的結論 MUST 為成功

#### Scenario: 測試失敗

- GIVEN backend 預設測試中有一個會失敗的測試
- WHEN 驗證執行到測試步驟
- THEN 測試步驟 MUST 顯示失敗並保留原始紀錄
- AND 整次驗證的結論 MUST 為失敗
- AND 後續 build 步驟 MUST NOT 使結論變為成功

#### Scenario: 安裝失敗

- GIVEN 依賴鎖定檔不一致，或安裝後的 patch 無法套用
- WHEN 驗證執行到安裝步驟
- THEN 安裝步驟 MUST 失敗，且 MUST NOT 自動修改鎖定檔或略過 patch
- AND 整次驗證的結論 MUST 為失敗

#### Scenario: lint 失敗

- GIVEN backend 存在型別錯誤
- WHEN 驗證執行到 lint 步驟
- THEN lint 步驟 MUST 失敗
- AND 整次驗證的結論 MUST 為失敗

### Requirement: 驗證逾時

每次 backend 驗證 MUST 有明確的執行時間上限。超過上限時，系統 MUST 終止該次驗證，且結論 MUST NOT 為成功。

#### Scenario: 驗證超過時間上限

- GIVEN 某個步驟持續執行而超過時間上限
- WHEN 達到時間上限
- THEN 系統 MUST 終止該次驗證
- AND 該次結論 MUST NOT 為成功
- AND 執行紀錄 MUST 可辨識是因超過時間上限而終止

### Requirement: 驗證取消與並行

同一 Pull Request 的新提交 MUST 取消該 Pull Request 尚在執行的舊驗證。不同 Pull Request、以及 Pull Request 與 push 的驗證 MUST NOT 互相取消。預設分支上執行中的驗證 MUST NOT 因新的 push 被取消。被取消的驗證 MUST NOT 呈現為成功。

#### Scenario: 同一 Pull Request 有新提交

- GIVEN 一個 Pull Request 的驗證正在執行
- WHEN 該 Pull Request 收到新提交
- THEN 舊驗證 MUST 被取消，且結論 MUST NOT 為成功
- AND 新提交 MUST 有自己的驗證結果

#### Scenario: 不同來源的驗證同時執行

- GIVEN 兩個不同 Pull Request 的驗證，或一個 Pull Request 與一次預設分支 push 的驗證同時執行
- WHEN 其中一方有新活動
- THEN 另一方 MUST NOT 被取消

#### Scenario: 預設分支連續 push

- GIVEN 預設分支有一次驗證正在執行
- WHEN 預設分支收到新的 push
- THEN 執行中的驗證 MUST 繼續到結束

### Requirement: 最小權限與測試隔離

Backend 驗證 MUST 只取得讀取 Repository 內容的權限，MUST NOT 注入模型、觀測平台或資料庫的憑證，checkout 後 MUST NOT 保留 Git 寫入憑證。需要資料庫、模型或外部網路的測試 MUST 依既有略過條件保持略過，deterministic 與 mock 測試 MUST 實際執行。

#### Scenario: 預設環境下的測試範圍

- GIVEN 驗證環境未提供任何資料庫連線或 live 開關
- WHEN 預設測試執行
- THEN 需要資料庫、模型或外部網路的測試 MUST 顯示為略過
- AND deterministic Weather Golden Eval、評分器單元測試與 mock integration MUST 實際執行

#### Scenario: 來自 fork 的 Pull Request

- GIVEN 一個來自 fork 的 Pull Request
- WHEN 驗證執行
- THEN 驗證 MUST NOT 取得任何 secret 或寫入權限

### Requirement: 狀態徽章語意

專案說明文件 MUST 顯示 Backend CI 狀態徽章。徽章 MUST 只反映預設分支 push 事件的最新驗證結論，並 MUST 連到以相同條件篩選的執行紀錄。系統 MUST NOT 提供靜態的成功圖片作為備援。

#### Scenario: 預設分支驗證成功

- GIVEN 預設分支最新一次 push 的驗證成功
- WHEN 讀者檢視徽章
- THEN 徽章 MUST 顯示通過
- AND 點擊後 MUST 看到預設分支 push 的執行紀錄

#### Scenario: 預設分支驗證失敗

- GIVEN 預設分支最新一次 push 的驗證失敗
- WHEN 讀者檢視徽章
- THEN 徽章 MUST NOT 顯示通過

#### Scenario: Pull Request 失敗不影響徽章

- GIVEN 預設分支最新一次 push 的驗證成功，且某個 Pull Request 的驗證失敗
- WHEN 讀者檢視徽章
- THEN 徽章 MUST 仍反映預設分支 push 的結論

#### Scenario: 預設分支尚無執行紀錄

- GIVEN 預設分支尚無任何 push 事件的驗證紀錄
- WHEN 讀者檢視徽章
- THEN 徽章 MUST NOT 顯示通過

#### Scenario: 徽章圖片無法載入

- GIVEN 徽章圖片載入失敗
- WHEN 讀者檢視專案說明文件
- THEN 讀者 MUST 仍能看到可辨識的替代文字
- AND MUST 仍能透過文字連結抵達執行紀錄

### Requirement: 驗證範圍揭露

專案說明文件的每個語言版本 MUST 說明徽章的範圍：只代表 backend 的 lint、預設測試與 build，包含 deterministic Weather Golden Eval、評分器單元測試與 mock integration；不包含需要資料庫或模型的整合測試與 live 評測；不涵蓋 frontend 與 BFF；不代表文件中的評測數字。本能力 MUST NOT 刪改既有文件內容或評測數字。

#### Scenario: 讀者查看評測章節

- GIVEN 任一語言版本的專案說明文件
- WHEN 讀者閱讀評測章節
- THEN 文件 MUST 同時寫明上述涵蓋與不涵蓋的項目

#### Scenario: 既有內容保持不變

- GIVEN 本能力的文件變更
- WHEN 比對變更前後的內容
- THEN 既有文字與評測數字 MUST 不變，且變更 MUST 只有新增行
