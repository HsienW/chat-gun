## ADDED Requirements

### Requirement: 評測 MUST 逐階段量測延遲

知識庫評測 MUST 逐題記錄 embedding、召回、rerank、回答生成與 Judge 五個階段的延遲與狀態。階段狀態 MUST 能區分已完成、失敗與未執行。既有的整題總延遲 MUST 保留且語意不變。量測 MUST NOT 改變檢索排序、門檻判定或線上檢索行為。

#### Scenario: vector_rerank 全部階段完成

- **GIVEN** 一題完成檢索、rerank、生成與 Judge 的案例
- **WHEN** 記錄結果
- **THEN** 五個階段 MUST 都標示已完成並帶有延遲
- **AND** 各階段延遲總和 MUST NOT 超過該題總延遲

#### Scenario: 設定上未執行 rerank

- **GIVEN** 一題使用 vector_only 設定的案例
- **WHEN** 記錄結果
- **THEN** rerank 階段 MUST 標示未執行，MUST NOT 記為 0

#### Scenario: 未產生回答

- **GIVEN** 一題檢索後沒有證據通過門檻，或回答標示為拒答的案例
- **WHEN** 記錄結果
- **THEN** 未被呼叫的生成或 Judge 階段 MUST 標示未執行

#### Scenario: rerank 失敗後降級

- **GIVEN** 一題 rerank 呼叫失敗或逾時，並降級為只用召回的案例
- **WHEN** 記錄結果
- **THEN** rerank 階段 MUST 標示失敗並記錄耗時
- **AND** 該題仍依既有規則標示為降級

#### Scenario: 階段失敗或逾時造成案例未完成

- **GIVEN** embedding、召回、生成或 Judge 階段因供應商錯誤或逾時失敗
- **WHEN** 記錄結果
- **THEN** 該階段 MUST 標示失敗，尚未開始的階段 MUST 標示未執行
- **AND** 該題 MUST 計為失敗，該次執行 MUST 標記為未完成

#### Scenario: 取消

- **GIVEN** 評測在某階段進行中被取消
- **WHEN** 記錄結果
- **THEN** 進行中的階段 MUST NOT 標示為已完成
- **AND** 該次執行 MUST 標記為未完成

#### Scenario: 舊結果相容

- **GIVEN** 新欄位加入前產生的評測結果
- **WHEN** 讀取該結果
- **THEN** 缺少階段延遲 MUST NOT 造成讀取失敗
- **AND** 階段延遲 MUST 呈現為未量測，MUST NOT 由其他數字推算

---

### Requirement: Rerank 延遲 MUST 只由階段量測發布

報表 MUST 分別呈現各階段的 P50、P95 與樣本數。Rerank 延遲 MUST 只由 rerank 階段已完成的量測計算，MUST NOT 由兩組設定的整題總延遲相減得出。整題總延遲 MUST 標示為包含生成與 Judge。

#### Scenario: 發布階段延遲

- **GIVEN** 一次已完成的 vector_rerank 評測
- **WHEN** 產出報表
- **THEN** 報表 MUST 含 embedding、召回、rerank、生成、Judge 的 P50、P95 與樣本數
- **AND** MUST 含由 embedding、召回與 rerank 組成的檢索總延遲

#### Scenario: 降級案例不進 Rerank 延遲

- **GIVEN** 一次評測中有 rerank 失敗的案例
- **WHEN** 計算 Rerank 延遲
- **THEN** 失敗案例 MUST NOT 納入 Rerank 的 P50、P95
- **AND** 報表 MUST 另列失敗次數
- **AND** 該次 rerank 失敗的耗時 MUST 計入檢索總延遲

#### Scenario: 設定未使用 rerank

- **GIVEN** 一組 vector_only 評測
- **WHEN** 產出報表
- **THEN** Rerank 延遲 MUST 顯示為未執行，MUST NOT 顯示為 0

#### Scenario: 未完成的執行

- **GIVEN** 一次標記為未完成的評測
- **WHEN** 產出報表
- **THEN** 階段延遲 MUST NOT 被標示為可發布

---

### Requirement: kb-eval-v2 MUST 是獨立的新資料集版本

系統 MUST 以獨立版本提供 `kb-eval-v2`。`kb-eval-v1` 的案例、分割與既有結果 MUST 維持不變。v2 的案例 MUST 使用既有 evaluation case 契約，新增資訊 MUST 以向後相容欄位表達，且 MUST 綁定語料版本。未指定資料集時，評測 MUST 繼續使用 `kb-eval-v1`。

#### Scenario: v1 不變

- **GIVEN** 已加入 v2 的程式
- **WHEN** 比對 v1 資料集與既有結果
- **THEN** 內容 MUST 與變更前相同
- **AND** 未指定資料集的評測 MUST 使用 v1

#### Scenario: 指定 v2

- **GIVEN** 已凍結的 v2
- **WHEN** 指定 v2 執行評測
- **THEN** 結果與 provenance MUST 記錄資料集版本 `kb-eval-v2`

#### Scenario: 指定資料集不合法

- **GIVEN** 資料集名稱不符合版本格式、指向資料目錄外，或檔案不存在
- **WHEN** 啟動評測
- **THEN** MUST 在呼叫任何模型前以明確錯誤結束

#### Scenario: 題目不與 v1 重複

- **GIVEN** v2 的所有題目
- **WHEN** 檢查資料集
- **THEN** 正規化後的題目 MUST NOT 與 v1 任何題目相同

---

### Requirement: kb-eval-v2 的組成與 ground truth MUST 可程式化驗證

v2 MUST 約 90 題：模板題 55 至 65 題、人工題 27 至 33 題，每題 MUST 標明來源類別。v2 MUST 涵蓋 `sku_lookup`、`same_series`、`multi_answer`、`near_miss`、`cross_lingual`、`cross_source` 六個必要標籤。每個必要標籤 MUST 符合：test 至少 10 題、其中人工題至少 5 題，dev 至少 3 題。拒答題 MUST 在 dev 至少 5 題、test 至少 10 題；對抗題 MUST 至少 2 題。組成驗證 MUST 不需呼叫模型，任何不符 MUST 以可辨識的問題代碼回報。

各題型的 ground truth MUST 符合：

- 可回答題的來源 MUST 存在於語料，每項 key fact MUST 出現在其相關來源中。
- `sku_lookup` 題目 MUST 包含相關商品的 SKU。
- `same_series` MUST 列出同品牌、同品類、同系列的其他商品，題目 MUST 足以分辨目標商品，且至少一項 key fact MUST 無法從所有同系列商品得到。
- `multi_answer` MUST 附可重新計算的查詢規則，相關來源 MUST 等於規則在語料上的完整結果，且為 2 至 5 個。
- `near_miss` MUST 是拒答題並列出最接近的既有來源；模板題使用的 SKU MUST 不存在於語料。
- `cross_lingual` 題目語言 MUST 與來源語言不同，且 test 中繁體中文與簡體中文 MUST 各至少 3 題。
- `cross_source` 的相關來源 MUST 跨至少兩種來源類型。
- 題目引用的商品標題若對應多個 SKU，且題目未指明 SKU，相關來源 MUST 包含全部對應商品。

#### Scenario: 合法資料集

- **GIVEN** 符合上述條件的 v2
- **WHEN** 執行組成驗證
- **THEN** MUST 回報沒有問題

#### Scenario: 必要標籤不足

- **GIVEN** 某必要標籤在 test 的人工題少於 5 題
- **WHEN** 執行組成驗證
- **THEN** MUST 回報該標籤與該下限未達成

#### Scenario: 多答案不完整

- **GIVEN** 一題 `multi_answer` 的相關來源少於查詢規則的完整結果
- **WHEN** 執行組成驗證
- **THEN** MUST 回報 ground truth 不一致

#### Scenario: 同系列題無法分辨

- **GIVEN** 一題 `same_series` 的 key fact 在所有同系列商品中都相同
- **WHEN** 執行組成驗證
- **THEN** MUST 回報該題無法區分同系列商品

#### Scenario: 標題相同的商品

- **GIVEN** 一題只提到標題、該標題對應兩個 SKU，且相關來源只列出其中一個
- **WHEN** 執行組成驗證
- **THEN** MUST 回報 ground truth 不完整

#### Scenario: 虛構 SKU 實際存在

- **GIVEN** 一題 near_miss 模板題使用的 SKU 存在於語料
- **WHEN** 執行組成驗證
- **THEN** MUST 回報該題不是拒答題

---

### Requirement: 來源 MUST 不跨分割

v2 中，同一來源 MUST 只出現在一個分割。判定 MUST 涵蓋相關來源、near_miss 的最接近來源與同系列商品，並依共用來源遞移。曾作為 `kb-threshold-v1` 校準依據的 v1 dev 來源，MUST NOT 作為 v2 test 的相關來源或最接近來源。

#### Scenario: 來源出現在兩個分割

- **GIVEN** 一個來源同時出現在 dev 與 test 的案例
- **WHEN** 執行組成驗證
- **THEN** MUST 回報來源跨分割，並列出來源與案例

#### Scenario: 經由共用來源遞移

- **GIVEN** 一題 dev 案例與一題 test 案例沒有相同的相關來源，但同屬一個同系列組
- **WHEN** 執行組成驗證
- **THEN** MUST 回報跨分割

#### Scenario: test 使用 v1 dev 來源

- **GIVEN** 一題 v2 test 案例的相關來源曾出現在 v1 dev
- **WHEN** 執行組成驗證
- **THEN** MUST 回報該來源已用於門檻校準

---

### Requirement: kb-eval-v2 MUST 在實作混合檢索前凍結

v2 MUST 在任何 v2 live 檢索評測與任何混合檢索實作之前凍結。凍結紀錄 MUST 包含內容雜湊、題數、凍結時間與 Master 對人工題的審閱紀錄。凍結前 MUST NOT 以任何檢索或模型結果調整題目。評測啟動時 MUST 驗證凍結紀錄，驗證未通過時 MUST NOT 呼叫任何模型。凍結後任何內容變更 MUST 發布新資料集版本。provenance MUST 記錄資料集內容雜湊。新檢索策略的對比 MUST 使用同一凍結版本上的 Baseline 結果。

#### Scenario: 已凍結

- **GIVEN** 內容雜湊與凍結紀錄一致的 v2
- **WHEN** 啟動評測
- **THEN** 評測 MUST 開始，且 provenance MUST 記錄該雜湊

#### Scenario: 內容遭變更

- **GIVEN** 凍結後被修改的 v2
- **WHEN** 啟動評測
- **THEN** MUST 在呼叫模型前以可與其他錯誤區分的失敗結束

#### Scenario: 尚未凍結

- **GIVEN** 要求凍結但沒有凍結紀錄的資料集
- **WHEN** 啟動評測
- **THEN** MUST 在呼叫模型前以可與其他錯誤區分的失敗結束

#### Scenario: 缺少 Master 審閱

- **GIVEN** 人工題尚未經 Master 審閱
- **WHEN** 建立凍結紀錄
- **THEN** 該資料集 MUST NOT 被標示為已凍結

#### Scenario: 凍結後修正錯誤

- **GIVEN** 凍結後發現一題 ground truth 有誤
- **WHEN** 修正該題
- **THEN** MUST 發布新資料集版本
- **AND** v2 檔案、凍結紀錄與既有結果 MUST NOT 被修改

#### Scenario: 不同資料集版本的對比

- **GIVEN** 新檢索策略只有新版本資料集的結果，Baseline 只有 v2 的結果
- **WHEN** 準備對比
- **THEN** MUST NOT 將兩者發布為同一基準上的提升

---

### Requirement: 報表 MUST 依來源類別與標籤分層

報表 MUST 對每個分割與每組設定，依來源類別（模板、人工）與標籤分層呈現既有指標。每個分層 MUST 顯示可回答題與拒答題的樣本數；沒有樣本的指標 MUST 顯示為不適用。一題可屬於多個標籤時，報表 MUST 說明分層會重疊、加總不等於總題數。沒有來源類別的舊案例 MUST 呈現為未分類，MUST NOT 被推測為人工。分層中的降級次數 MUST 只計該分層的案例。分層的 model-assisted 分數 MUST 遵守既有人工抽查規則。

#### Scenario: 產出分層表

- **GIVEN** 一次 v2 評測
- **WHEN** 產出 test 報表
- **THEN** MUST 分別呈現人工、模板與所有必要標籤的指標與樣本數

#### Scenario: 分層沒有對應樣本

- **GIVEN** `near_miss` 分層全部是拒答題
- **WHEN** 產出報表
- **THEN** Recall@5 與 MRR MUST 顯示為不適用，MUST NOT 顯示為 0

#### Scenario: 舊資料集

- **GIVEN** 以 v1 執行的評測
- **WHEN** 產出報表
- **THEN** 既有指標 MUST 與變更前的計算相同
- **AND** 來源類別 MUST 顯示為未分類

#### Scenario: 分層中的未完成案例

- **GIVEN** 一次因供應商失敗或逾時而未完成的評測
- **WHEN** 產出分層表
- **THEN** 報表 MUST 標示不可發布
- **AND** MUST NOT 以成功子集產生提升判定

---

### Requirement: 模板題分數 MUST NOT 被當作整體提升

混合模板題與人工題的總分 MUST 標示為混合總分且不可作為提升依據。設定之間的提升判定 MUST 只由同一分割的人工題分層計算，且 MUST 來自相同的資料集版本與內容雜湊。模板題分層 MUST 標示為診斷用途。人工題分層樣本數少於 5 題時 MUST NOT 判定提升；差異小於該分層一題的解析度時 MUST 標示為解析度內。

#### Scenario: 只有模板題提升

- **GIVEN** 一組設定的模板題 Recall@5 上升，人工題 Recall@5 持平
- **WHEN** 產出報表
- **THEN** 提升判定 MUST 顯示人工題沒有提升
- **AND** 模板題的上升 MUST 只出現在診斷區塊

#### Scenario: 人工題提升

- **GIVEN** 一組設定的人工題 Recall@5 上升幅度超過一題解析度
- **WHEN** 產出報表
- **THEN** 提升判定 MUST 列出差異與樣本數

#### Scenario: 樣本不足

- **GIVEN** 某標籤的人工題分層只有 3 題可回答題
- **WHEN** 產出提升判定
- **THEN** MUST 標示樣本不足，MUST NOT 判定提升

#### Scenario: 雜湊不同

- **GIVEN** 兩次執行的資料集內容雜湊不同
- **WHEN** 產出提升判定
- **THEN** MUST 拒絕比較並標示原因

---

### Requirement: 報表 MUST 揭露離線 Query 與線上 Query 的差異

檢索評測 MUST 記錄查詢模式。以案例原始問題直接檢索時，provenance MUST 標示為原始問題，報表 MUST 聲明線上由模型組 Query，因此檢索分數不代表線上端到端結果，也未涵蓋 Query 組裝、Tool 參數選擇與線上回答 Prompt。

#### Scenario: 原始問題評測

- **GIVEN** 一次以原始問題檢索的評測
- **WHEN** 產出報表與 provenance
- **THEN** provenance MUST 標示查詢模式
- **AND** 報表 MUST 包含上述聲明

#### Scenario: 跨語言分數

- **GIVEN** `cross_lingual` 分層的結果
- **WHEN** 閱讀報表
- **THEN** 該分層 MUST 被說明為未翻譯的原始問題結果，MUST NOT 被報告為線上跨語言品質
