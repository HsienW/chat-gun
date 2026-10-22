# readme-architecture-diagram

## ADDED Requirements

### Requirement: 架構章節以可渲染的圖呈現已實作的系統分層

專案說明文件的架構章節 MUST 以 Mermaid 圖呈現請求從瀏覽器到 Model Provider 經過的層次，以及可觀測性的接入位置。圖上方 MUST 有一句說明該圖回答的問題。

#### Scenario: 讀者在 GitHub 檢視架構章節

GIVEN 變更已推送至 GitHub
WHEN 讀者開啟任一語言版本的專案說明文件並捲動至架構章節
THEN 架構圖 MUST 被渲染為圖形，而非顯示原始碼或語法錯誤
AND 圖上方 MUST 有一句說明這張圖回答的問題

#### Scenario: Mermaid 語法無法渲染

GIVEN 圖的原始碼含有 GitHub 無法解析的語法
WHEN 驗收者在 GitHub 檢視該文件
THEN 該變更 MUST 被判定為未通過驗收
AND MUST NOT 以本地預覽結果取代 GitHub 實際渲染結果

### Requirement: 圖上只包含已實作的元件與呼叫關係

架構圖的每個節點與邊 MUST 對應目前程式碼中已實作的元件或呼叫關係。圖 MUST NOT 包含尚未實作的能力。

#### Scenario: 所有 Graph 與 Provider 皆出現在圖上

GIVEN Backend 註冊了四個 Graph，且 LLM Gateway 支援三個 Provider
WHEN 驗收者比對圖與程式碼
THEN 圖 MUST 包含每一個已註冊的 Graph 與每一個已支援的 Provider
AND 每個 Graph MUST 有一條邊連到 LLM Gateway

#### Scenario: 只有實際使用 Tool Registry 的 Graph 連到 Tool Registry

GIVEN 部分 Graph 經由 Tool Registry 載入工具，部分沒有
WHEN 驗收者比對圖與程式碼
THEN 圖 MUST 只為實際經由 Tool Registry 載入工具的 Graph 畫出連到 Tool Registry 的邊

#### Scenario: 尚未實作的檢索能力不出現在圖上

GIVEN 私有語料檢索工具與向量庫尚未實作
WHEN 驗收者檢視架構圖
THEN 圖 MUST NOT 包含檢索工具或向量庫節點

#### Scenario: 施工時發現圖與程式碼不一致

GIVEN 施工者發現已核准的圖內容與程式碼不符
WHEN 施工者準備修改文件
THEN 施工者 MUST 停止並回報不一致之處
AND MUST NOT 自行修改已核准的圖內容

### Requirement: 三種語言版本的圖結構完全一致

繁中、英文、简中三份專案說明文件的架構圖 MUST 有相同的節點 ID 集合與相同的邊集合，只允許標籤文字在地化。技術名詞、Graph ID 與 Provider 名稱 MUST 在三份文件中保持英文。

#### Scenario: 比對三份文件的圖結構

GIVEN 三份文件皆已加入架構圖
WHEN 以腳本抽出各自的 Mermaid 區塊並忽略標籤文字比對
THEN 三份的節點 ID 集合 MUST 相同
AND 三份的邊集合（含實線與虛線類型）MUST 相同

#### Scenario: 只更新其中一份文件

GIVEN 某次修改只變更了一種語言版本的圖結構
WHEN 執行結構比對
THEN 比對 MUST 失敗
AND 該變更 MUST NOT 通過驗收

### Requirement: 變更範圍僅限架構圖

本變更 MUST 只替換架構章節中的系統流程描述，MUST NOT 修改專案說明文件的其他章節或任何程式碼、設定、規則檔。

#### Scenario: 檢查變更範圍

GIVEN 施工完成
WHEN 驗收者檢視 Git Diff
THEN Diff MUST 只包含三份專案說明文件架構章節中的圖、說明句與被取代的流程描述
AND 目錄對照表、說明段落與本地代理流程描述 MUST 保持不變
