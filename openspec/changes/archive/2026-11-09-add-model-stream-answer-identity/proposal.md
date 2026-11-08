# Proposal：擴充 model.stream 回答正文身分欄位（上游 gun-harness）

## 背景

Change `stream-chat-answer-text` 的 Task 1.4 閘門證實：`@gun-ai/harness-contracts@0.1.0-alpha.3` 的 `model.stream` payload schema 為 strict，只宣告 `delta`，帶 `messageId`、`outputKind`、`textOffset` 的 payload 以 `unrecognized_keys` 被拒（`stream-chat-answer-text` 的 `implementation-gate-evidence-01`）。Master 於 2026-11-04 核准在上游擴充契約，不在 chat-gun 繞過。

依前例（`2026-10-10-extract-stable-gun-harness-contracts`、`2026-10-14-agent-tool-sdk-and-manifest`），上游 `gun-harness` 的修改由 chat-gun OpenSpec 規劃，實作在 `gun-harness` repo，發布由 Master 決定並執行。

## 目標

- `model.stream` payload 支援三個選用的回答正文身分欄位，並在契約層做 runtime validation。
- 既有只有 `delta` 的 payload 維持有效；schema 維持 strict，其他未知欄位仍拒收。
- kernel 的公開解析入口完整保留這三個欄位。
- 經 Master 核准後發布新的精確 alpha 版本，供 `stream-chat-answer-text` Task 1.7 承接。

## 非目標

- 不修改 chat-gun 的 backend、bff、frontend 程式；chat-gun 的依賴升級與 adapt 屬於 `stream-chat-answer-text` Task 1.7。
- 不決定「三者齊備才進入正文路徑」等消費端行為；那屬於 `stream-chat-answer-text` 的 `runtime-event-contract` 規格。
- 不放寬 `model.stream` 或其他事件的 strict 行為，不新增事件類型。
- 不在 `gun-harness` 初始化 OpenSpec 或建立新的治理流程。
- 不處理 provenance／signing 等 X29 發布治理。

## 受影響套件與能力域

| 範圍 | 影響 |
|---|---|
| `gun-harness`：`@gun-ai/harness-contracts` | `model.stream` payload schema 擴充；新增輸出種類的封閉常數與型別（公開 export） |
| `gun-harness`：`@gun-ai/harness-kernel` | 程式不需修改；新增測試證明公開解析入口保留欄位；版本與相依版本同步 |
| `gun-harness`：`@gun-ai/harness-sdk`、`@gun-ai/harness-testkit` | 程式不需修改；相依版本同步，維持一批精確版本 |
| chat-gun | 只有本 Change 的 OpenSpec artifacts；不修改程式 |
| 能力域 | Runtime event contract（harness 契約層） |

## 規格決策

- 三個欄位各自選用；凡出現的欄位都必須通過自身驗證。只有 `delta`、或只帶部分合法身分欄位的 payload 都通過契約。
- 輸出種類為封閉 enum，本次只有 `answer_text`，由 contracts 單一來源匯出。
- 文字偏移為非負安全整數，語意為本訊息先前已發布文字的 UTF-16 code unit 數。
- 版本：四個套件一起升為 `0.1.0-alpha.4`，套件間維持精確相依。`RUNTIME_EVENT_SCHEMA_VERSION` 的處理見 design D4。

## 風險

| 風險 | 影響 | 緩解 |
|---|---|---|
| 舊版（alpha.3）strict 消費端收到帶新欄位的 payload | 解析失敗 | CHANGELOG 明載；chat-gun 端由功能開關控制，先升級消費端再開啟發送（`stream-chat-answer-text` design D5） |
| kernel 或下游 helper 剝除欄位 | 正文身分遺失 | 以 kernel 公開入口測試保留；testkit fixture 透傳測試 |
| 版本不一致（部分套件仍依賴 alpha.3） | 安裝出現兩份 contracts | 四個套件一起升版，發布前以 clean install 驗證相依樹只有一份 contracts |
| 未經核准發布 | 違反 `harness-package-boundary` | 發布只由 Master 執行；Agent 不得 publish |

## 回滾

新欄位為選用，chat-gun 未升級前不受影響。若發布後發現問題：chat-gun 維持 alpha.3 或回退 lockfile；上游以 `npm dist-tag` 將 `alpha` 指回 alpha.3，或發布修正版。已發布版本不覆寫。
