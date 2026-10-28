## MODIFIED Requirements

### Requirement:專案 slug 與顯示名稱

專案對外識別名稱 MUST 統一為：slug `chat-gun`、顯示名稱 `Chat Gun`。前端首頁的產品標題 MUST 為 `Chat Gun AI Agent`；首頁兩個入口的名稱與子標題 MUST 分別為 `Gun Chat`／「Generative AI Agent」與 `Gun Shop`／「Shop AI Assistant」。首頁產品標題與入口名稱只用於前端首頁與入口工作區，MUST NOT 取代專案顯示名稱。

#### Scenario:顯示名稱一致

GIVEN 使用者開啟前端頁面或閱讀專案文件
WHEN 檢視瀏覽器頁籤標題，以及首頁產品標題與入口名稱以外的使用者可見專案名稱
THEN 顯示名稱皆為 `Chat Gun`
AND 不再出現 `Chat Gun React Agent`。

#### Scenario:首頁產品標題與入口名稱

GIVEN 使用者開啟前端首頁
WHEN 檢視首頁標題與兩個入口
THEN 首頁標題為 `Chat Gun AI Agent`
AND 兩個入口分別為 `Gun Chat`（子標題「Generative AI Agent」）與 `Gun Shop`（子標題「Shop AI Assistant」）
AND 首頁不再出現舊標題 `ChatGun AI Agent`
AND 瀏覽器頁籤標題仍為 `Chat Gun`。

#### Scenario:專案設定識別

GIVEN OpenSpec 專案設定記載專案名稱
WHEN 讀取其 context 中的專案名稱
THEN 其值為 `chat-gun`。
