## ADDED Requirements

### Requirement: 公開保存的 runtime 產出只含可對外內容

版本控制中保存的自建 runtime 產出 MUST 只包含下游部署會使用的映像建置設定、啟動入口與對外說明文件。對外說明文件與保留的檔案 MUST NOT 包含內部 agent 工作流程細節（交接編號、共享狀態、角色或 owner、仲裁輪次）、本機 Runtime Artifact 路徑、evidence 識別碼，或 Git 忽略的私有設定檔名稱與內容描述。一次性驗證工具 MUST NOT 保留在目前 tree；其歷史版本 MUST 可由明確的 commit 引用追溯。保留的建置與啟動行為 MUST 與移除前一致。

#### Scenario: 保留內容滿足下游部署

- **GIVEN** 公開產出已依內容邊界整理
- **WHEN** 以保留的建置設定建置 runtime 與 BFF 映像
- **THEN** 兩個映像建置成功
- **AND** 映像的啟動命令與移除前相同
- **AND** 下游部署 Change 引用的建置與啟動檔案都存在

#### Scenario: 公開內容不含內部工作流程細節

- **GIVEN** 公開產出已依內容邊界整理
- **WHEN** 搜尋保留檔案中的內部工作流程字樣、本機 Runtime Artifact 路徑與私有設定檔名稱
- **THEN** 沒有任何命中
- **AND** 任一命中使該驗收項目不通過，MUST 修正後重新搜尋，MUST NOT 以路徑白名單略過

#### Scenario: 一次性驗證工具仍可追溯

- **GIVEN** 一次性驗證工具已從目前 tree 移除
- **WHEN** 讀者依可行性結論中的重現說明查找工具
- **THEN** 說明 MUST 指向保存工具的 commit
- **AND** 該 commit 中的工具內容與移除前一致

#### Scenario: 下游仍依賴已移除的檔案

- **GIVEN** 下游部署 Change 的規格、設計或任務引用了將被移除的檔案
- **WHEN** 進行驗收前的依賴搜尋
- **THEN** 該驗收項目不通過
- **AND** MUST 回報 Coordinator 決定保留該檔案或先調整下游 Change，MUST NOT 直接修改下游 Change
