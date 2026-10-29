[← 回到 README](../README.md)

# README 整併對照與檢查紀錄

本次依 Master 在聊天中的明確授權，直接整理 README.md，不進入 OpenSpec lifecycle。附件為整併參考；其指定的 README.md、推送分支及後續多語同步，未自動套用為本次操作。原稿 754 行，整併後 192 行。

## 本次更正

依使用者補充的舊版 C:/D/ai-agent/README.md，保留 README 頂部的定位兩段與「核心功能」條列，順序由兩個使用入口、Agent-workflows、知識庫檢索開始；同時依整併規劃集中展示 RAG、售後客服鏈路、核准、冪等與結果未知、全端可信邊界、可重現評測及 SDK，為對應條列補上文件與測試證據連結。原有串流、多模態、Tools、MCP 與模型 Provider 能力接續保留。頂部不使用能力表，評測數字集中於後面的評測摘要；Demo 之後的內容保持本輪更正前版本。

## 修改範圍

- 主文件：[README.md](../README.md)。
- 新建九份內容文件：快速開始、設定、Gun Shop、檢索、評測、Tools 與 MCP、可觀測性、疑難排解、範圍與限制；另新增本份對照紀錄。
- 補充既有文件：architecture.md、bff.md、tool-security-isolation.md。原有內容保留。
- 未修改應用程式、依賴、LICENSE、README.md 或其他語言 README；保留工作區原有未提交變更。

## 逐段搬移對照

以下行號固定指整併前的 754 行原稿。「完成」表示本機內容搬移與對照完成，不代表已通過 GitHub 渲染或人工審查。

| 狀態 | 原章節 | 原行號 | 新位置與處理 |
| --- | --- | --- | --- |
| 完成 | 技術徽章 | 7–14 | [README.md](../README.md)，保留原徽章，新增 React 19 與 TypeScript |
| 完成 | Origins 徽章 | 15 | 移除展示；授權核實結果見下文 |
| 完成 | 評測模型徽章 | 17–24 | [完整評測](./evaluation.md)保留六個，README 評測摘要保留三個核心徽章 |
| 完成 | 語言切換 | 26–30 | README 保留切換列，繁中連結指向本次編輯檔案 |
| 完成 | 定位兩段 | 32–34 | README 依使用者補充的舊版還原定位兩段；[Gun Shop](./gun-shop.md)亦保留原文 |
| 完成 | 核心功能清單 | 36–59 | 依使用者更正，README 頂部保留舊版條列說法，前三項不變；將整併規劃的重點能力集中排序並補上證據連結，不使用能力表；子文件提供下列詳細閱讀入口 |
| 完成 | 兩個入口、Agent-workflows | 38–46 | [Gun Shop](./gun-shop.md) |
| 完成 | 知識庫檢索 | 47 | [檢索](./retrieval.md) |
| 完成 | 核准、冪等、操作狀態 | 48–50 | [Gun Shop](./gun-shop.md) |
| 完成 | Streaming、HITL、Multimodal | 51–53 | [架構](./architecture.md#入口與互動能力)補充互動能力摘要 |
| 完成 | Native Tools、MCP、SDK | 54–56 | [Tools 與 MCP](./tools-and-mcp.md) |
| 完成 | Model providers | 57 | [架構](./architecture.md#入口與互動能力)，既有 Gateway 章節保留詳細說明 |
| 完成 | API Gateway | 58 | [BFF](./bff.md)既有章節承接認證、Principal、CORS、大小限制、逾時、取消及限流，另補 State 防護 |
| 完成 | Observability & Evaluation | 59 | [可觀測性](./observability.md)、[評測](./evaluation.md) |
| 完成 | 部署警告 | 61–62 | README 壓為一行；[快速開始](./getting-started.md)保留原文 |
| 完成 | Demo 四張圖 | 64–80 | README 保留 demo.webp 與 01.png；[Gun Shop](./gun-shop.md#操作畫面)保留 02.png 與 03.png，修正相對路徑 |
| 完成 | 架構圖與目錄表 | 82–150 | README 保留全部節點、連線與目錄表；部分 Mermaid statement 以分號併行，順序及內容不變 |
| 完成 | 本地代理路徑 | 152–158 | [快速開始](./getting-started.md) |
| 完成 | 入口與 Agents | 160–181 | [Gun Shop](./gun-shop.md#入口與-agents) |
| 完成 | Gun Shop 流程走查與狀態表 | 183–208 | [Gun Shop](./gun-shop.md#gun-shop-流程走查)，保留九種狀態及無 undo 語意 |
| 完成 | 評測結果全文 | 210–293 | [評測](./evaluation.md)完整保留原文；README 僅列 test split 摘要 |
| 完成 | 系統需求、安裝 | 295–330 | [快速開始](./getting-started.md) |
| 完成 | Backend、知識庫、BFF、Frontend 設定 | 332–457 | [設定](./configuration.md)，修正相對連結及章節層級 |
| 完成 | 知識庫設計說明 | 381、388、410 | [設定](./configuration.md#知識庫)保留，另在[檢索](./retrieval.md#資料與索引邊界)提供設計入口 |
| 完成 | BFF State 寫入防護 | 447 | [設定](./configuration.md#bff)保留，並補入 [BFF](./bff.md#對話-state-的寫入防護) |
| 完成 | 本地開發、知識庫準備、健康檢查 | 459–521 | [快速開始](./getting-started.md) |
| 完成 | 匯入續跑與冪等 | 483–505 | [快速開始](./getting-started.md#準備知識庫)與[檢索](./retrieval.md#匯入與續跑) |
| 完成 | Tools、擴充、MCP | 523–579 | [Tools 與 MCP](./tools-and-mcp.md)，與既有安全文件互相連結 |
| 完成 | Observability | 581–615 | [可觀測性](./observability.md) |
| 完成 | Docker Compose | 617–660 | [快速開始](./getting-started.md#docker-compose)完整保留；README 提供最短路徑及主機／容器連線提醒 |
| 完成 | 測試 | 662–690 | [快速開始](./getting-started.md#測試) |
| 完成 | 實際並行驗證說明 | 690 | [快速開始](./getting-started.md#測試)與 [Gun Shop](./gun-shop.md#並行與回歸驗證)，附測試原始碼入口 |
| 完成 | 疑難排解 | 692–729 | [疑難排解](./troubleshooting.md) |
| 完成 | 範圍與限制 | 731–743 | [完整限制](./scope-and-limitations.md)保留原文；README 保留五條摘要 |
| 完成 | 文件列表 | 745–750 | README 改為「領域、核心主題、閱讀入口」三欄導覽，保留四份既有入口 |
| 完成 | License | 752–754 | README 保留 Apache License 2.0 與 LICENSE 連結 |

## 重疊內容處理

快速開始集中操作步驟，設定文件集中環境變數；檢索文件另保留與設計直接相關的資料邊界、維度、tenant、刪除連動與續跑說明。Gun Shop 另保留並行驗證說明，便於直接連到測試證據。

架構與 BFF 文件採補充方式：既有 Gateway、Principal、CORS、限流、串流與 checkpoint 章節不重寫；新增互動摘要及缺少的 State 防護段落。Tools 與 MCP 講用法，既有 tool-security-isolation.md 保留安全細節，兩者互相連結。

## 數據與溯源

- 完整評測原文與所有表格逐行搬移；README 評測摘要的 test split 表格前六欄與原表一致，保留 0.300、0.100 的精度，未採附件縮寫的 0.30、0.10。
- 頂部以原版功能條列介紹兩個入口與各 Agent 用途，重點能力附可點擊證據；評測數字集中於評測摘要，並附資料集、語料／合成訂單、模型識別、執行日期與次數，流程摘要保留 qwen3.7-plus 及兩個 prompt 版本。
- 評測摘要同時呈現 deterministic test 10／10 與 live test 3／10，明列其餘 7 題訂單操作空結果及尚未修正。
- 先前執行的人工複核與評審一致率 0.600 完整留在評測方法學。原文未提供該次執行完整溯源，因此未將其列入 README 評測摘要。實際並行案例的測試連結保留於 Gun Shop 文件。
- 沿用原稿結果，未重跑 deterministic、live 或模型評測，亦未執行 Docker 啟動。

## Origins 與授權檔核實

檢查根 LICENSE、backend/LICENSE、可見 NOTICE 檔案清單及未忽略的程式碼文字。根 LICENSE 為 Copyright 2026 HsienW 的 Apache License 2.0；backend/LICENSE 另保有 Copyright (c) 2025 Philipp Schmid 的 MIT 授權聲明。未找到 NOTICE 檔，也未在受查程式碼中找到具名 Ylang-Labs／langgraph-react-agent-studio 來源或版權檔頭。

上述文字檢查不能證明完全不存在衍生程式碼。本次只移除 README 的 Origins 徽章，所有授權檔及原有版權聲明均未修改，不據此宣稱來源或授權義務消失。

## 發現的既有差異

1. architecture.md 的「可用 Agent」仍描述四個 graph，原 README 與 backend/langgraph.json 已列五個，包含 shopping_assistant。保留既有架構敘述，並以 Gun Shop 的完整表格提供閱讀入口，待另行釐清與更新。
2. architecture.md 仍描述 Math Agent 直接呼叫 calculator、不經 Registry；原 README 宣稱所有工具統一經 Tool Dispatch，Mermaid 也畫出 math_agent 至 Registry。tool-security-isolation.md 另保留直接匯入 Tool 不自動受 Registry 保護的敘述。本次原樣保留並記錄差異，未藉整併裁定實作行為。
3. 原 Compose 章節同時說明容器內連線已配置，並提醒 KNOWLEDGE_DATABASE_URL 可被外部環境值覆寫。整併保留完整說明，README 快速路徑額外區分主機匯入與容器使用的連線位置；未實際啟動驗證。

## 本機驗證與待辦

- 已完成：完整評測及操作原文搬移比對、README test split 數字比對、Mermaid statement 等同性比對、Markdown code fence 配對、相對檔案／圖片路徑與標題錨點靜態檢查、git diff --check。
- 未執行：應用程式 lint、test、build；本次僅編輯 Markdown，沒有執行期修改。
- 未執行：外部 URL 可用性、GitHub 實際點擊、Mermaid 的 GitHub 渲染與桌面首屏視覺驗證；未推送，不能宣稱已通過這些項目。
- 待人工審閱繁中內容，再決定發布、既有文件差異修正及其他語言同步。README.md、README-next-en.md、README.en.md 與 README.zh-CN.md 均未在本次修改。
