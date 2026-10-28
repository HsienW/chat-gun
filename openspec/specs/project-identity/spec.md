# project-identity Specification

## Purpose
定義專案「對外身分 token」的統一命名契約，作為縮名 `chat-gun-react-agent` → `chat-gun` 的驗收基準。本 capability 為靜態身分改名，無執行期逾時／取消／重試語意；Scenario 以「一致性」與「不殘留舊名」作為可驗證的成功／失敗邊界。
## Requirements
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

### Requirement:Package 命名一致性

backend、bff、frontend 三個 workspace 的 package 名稱與其 lockfile 根名稱 MUST 一致，且使用 `chat-gun-*` 前綴。

#### Scenario:三個 package 名稱符合縮名

GIVEN 三個 workspace 的 package 元資料與 lockfile
WHEN 檢查其根 package 名稱
THEN backend 為 `chat-gun-backend`、bff 為 `chat-gun-bff`、frontend 為 `chat-gun-frontend`
AND 各 package 元資料與其 lockfile 根名稱一致。

#### Scenario:無程式碼依賴舊 package 名稱

GIVEN 縮名完成的程式碼
WHEN 搜尋舊 package 名稱 `chat-gun-react-agent-backend`、`chat-gun-react-agent-bff`、`chat-gun-react-agent-frontend`
THEN 除 archived OpenSpec 外無任何命中。

### Requirement:對外 HTTP User-Agent

backend 對外部 HTTP API 發起工具呼叫時，User-Agent 標頭 MUST 使用 `chat-gun/<version>`，不得使用舊名稱。

#### Scenario:HTTP 工具使用新 User-Agent

GIVEN backend 透過 weather、web-fetch、web-search 或 geocoding 能力發起對外 HTTP 請求
WHEN 檢查請求的 User-Agent 標頭
THEN 其值以 `chat-gun/` 為前綴
AND 不含 `chat-gun-react-agent`。

### Requirement:MCP client 識別

backend 連接 MCP Server 時，client name MUST 為 `chat-gun-<serverName>`。

#### Scenario:MCP client name 使用新前綴

GIVEN backend 初始化任一 MCP Server 連線
WHEN 檢查傳遞給 MCP Server 的 client name
THEN 其值為 `chat-gun-<serverName>` 形式
AND 不含 `chat-gun-react-agent`。

### Requirement:Observability 識別

OpenTelemetry service name 與 Opik project name 的預設值 MUST 為 `chat-gun`。

#### Scenario:未覆寫環境變數時的預設值

GIVEN 執行期未以環境變數覆寫 `OTEL_SERVICE_NAME` 或 `OPIK_PROJECT_NAME`
WHEN 讀取 runtime config 的預設值
THEN 兩者皆為 `chat-gun`。

#### Scenario:測試 expectation 與預設值一致

GIVEN runtime config 的單元測試
WHEN 執行測試
THEN 預設值 assertion 為 `chat-gun`，且測試通過。

### Requirement:Docker image 命名

backend 與 bff 的 Docker image 名稱 MUST 分別為 `chat-gun` 與 `chat-gun-bff`。

#### Scenario:compose 引用新 image 名稱

GIVEN Docker compose 設定
WHEN 檢查 backend 與 bff 的 image 欄位
THEN 分別為 `chat-gun` 與 `chat-gun-bff`
AND 不含 `chat-gun-react-agent`。

