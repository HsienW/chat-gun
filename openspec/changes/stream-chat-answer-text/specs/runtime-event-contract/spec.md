## MODIFIED Requirements

### Requirement: 前端去重與 bounded reordering

Frontend MUST 以 `eventId` 去重、以 `(runId, sequence)` 做 bounded reordering buffer，且 buffer MUST 有上限（有預設值、可配置、超窗推進具可觀察 metric）；duplicate 交付 MUST 只改變一次狀態。bounded reordering MUST NOT 作為回答正文事件的放行閘門：回答正文 MUST 以其訊息身分與文字偏移為唯一順序依據，抵達即可套用；正文事件仍 MUST 進入 reordering buffer 以維持 `sequence` 連續。

#### Scenario: duplicate 交付只改變一次狀態

- GIVEN 同一 `eventId` 的事件被重複交付
- WHEN reducer 處理
- THEN 第二次及之後的交付 MUST NOT 再改變狀態
- AND 去重集合 MUST 有界（不無限制成長）

#### Scenario: bounded out-of-order 收斂

- GIVEN 亂序到達的事件（sequence 缺口小於 window）
- WHEN reducer 依 window buffer 排序
- THEN MUST 收斂至與有序到達相同的確定性結果
- AND 缺口大於 window 時 MUST 向前推進而非無限等待
- AND 推進行為 MUST 有可觀察 metric

#### Scenario: 正文不受 sequence 缺口阻擋

- GIVEN 一個回答正文事件的 `sequence` 之前仍有未抵達的事件
- WHEN 正文事件抵達
- THEN 正文 MUST 依其文字偏移立即套用
- AND 該事件 MUST 仍進入 reordering buffer
- AND 活動流程 MUST NOT 因此重複呈現該正文

## ADDED Requirements

### Requirement: model.stream 回答正文身分欄位

`model.stream` payload MUST 支援選用的回答正文身分欄位：訊息身分、輸出種類（回答正文）與文字偏移。只有三者與合法 `delta` 齊備的事件可進入回答正文路徑；只有 `delta` 的既有事件 MUST 維持活動用途。文字偏移 MUST 以本訊息先前已發布文字的 UTF-16 code unit 數表示，第一段為 0。文字偏移 MUST 以上游位元組解碼成文字之後的結果計算，MUST NOT 以傳輸層的 UTF-8 byte 偏移或 chunk 邊界計算；被拆開的 surrogate pair MUST 在補齊後才計入偏移。

#### Scenario: 多位元組文字的偏移

- GIVEN 已發布文字含中文與由 surrogate pair 組成的 emoji，且上游 chunk 在多位元組字元或 surrogate pair 中間切開
- WHEN 產生端發布下一段正文
- THEN 該段文字偏移 MUST 等於先前已發布文字解碼後的 UTF-16 code unit 總數
- AND MUST NOT 等於其 UTF-8 byte 數
- AND 消費端依偏移接合後的全文 MUST 與終稿逐字相同

#### Scenario: 正文事件欄位齊備

- GIVEN 一個帶訊息身分、輸出種類為回答正文、文字偏移與合法 `delta` 的 `model.stream` 事件
- WHEN 消費端驗證
- THEN MUST 交給回答正文路徑

#### Scenario: 欄位不齊備

- GIVEN 一個 `model.stream` 事件缺少任一正文身分欄位，或欄位型別不合法
- WHEN 消費端驗證
- THEN MUST NOT 進入回答正文路徑
- AND 只有 `delta` 的事件 MUST 沿用活動用途
- AND 型別不合法 MUST 依既有未知事件策略安全降級

#### Scenario: 舊消費端相容

- GIVEN 消費端尚未支援正文身分欄位
- WHEN 收到帶新欄位的 `model.stream` 事件
- THEN 新欄位 MUST NOT 造成 envelope 驗證失敗
