# Design：擴充 model.stream 回答正文身分欄位（上游 gun-harness 施工方案）

## Context

| 項目 | 現況（`gun-harness` @ `3d9f25f`，分支 `v0.0.3/feat/deduplicated-governed-outcome-alpha.3`） |
|---|---|
| contracts schema | `packages/contracts/src/events.ts` 的 `RUNTIME_EVENT_PAYLOAD_SCHEMAS["model.stream"]` 為 `z.object({ delta: z.string().max(65_536) }).strict()` |
| 既有識別碼 schema | 同檔 `opaqueIdSchema = z.string().trim().min(1).max(256)`（模組私有） |
| 事件型別常數 | 同檔 `RUNTIME_EVENT_TYPES`（`as const` 陣列）與 `RuntimeEventType`，經 `src/index.ts` 具名匯出 |
| kernel | `packages/kernel/src/events.ts`：`parseRuntimeEventEnvelope()` 委派 `runtimeEventEnvelopeSchema`（`payload: z.unknown()`）；`parseRuntimeEventPayload(type, payload)` 呼叫 `RUNTIME_EVENT_PAYLOAD_SCHEMAS[type].parse()`。沒有第二份欄位白名單 |
| testkit | `packages/testkit/src/fixtures.ts` 的 envelope fixture 直接透傳 `input.payload`，沒有 `model.stream` 專屬映射 |
| 公開 API 治理 | 各套件 `src/index.ts` 為唯一入口，禁止 wildcard；`api-surface.json` 的 `runtime`／`types` 陣列由 `src/api-surface.test.ts` 與實際匯出比對 |
| 版本 | contracts、kernel、sdk、testkit 皆為 `0.1.0-alpha.3`，套件間精確相依 |
| 驗證入口 | root `npm run check` = build + typecheck + `node --test "packages/**/dist/**/*.test.js"`；CI 只跑 `npm ci` 與 `npm run check` |
| 政策 | `docs/api-policy.md`：新增相容匯出需 minor 版本決策；序列化契約帶明確 `schemaVersion`；發布前須 typecheck、tests、API-surface、boundary/cycle、clean install、`npm pack --dry-run`；首次發布由 Human 核准 |
| 前例 | alpha.3 於 CHANGELOG 記載「Prepare alpha.3 under Master authorization for the Chat Gun … consumer；retain schema version 1.0」 |

測試風格：`node:test` 的 `describe`／`it` 與 `node:assert/strict`，測試檔與原始碼同目錄（`src/*.test.ts`），經 build 後於 `dist/` 執行。

## Goals / Non-Goals

見 proposal。本 design 為 Codex 在 `gun-harness` 施工的技術方案；chat-gun 程式不在範圍內。

## Decisions

### D1：輸出種類常數與型別（contracts）

在 `packages/contracts/src/events.ts` 新增，命名對齊既有 `RUNTIME_EVENT_TYPES`／`RuntimeEventType`：

```ts
/** Closed set of `model.stream` output kinds. @since 0.1.0-alpha.4 */
export const MODEL_STREAM_OUTPUT_KINDS = ["answer_text"] as const;
export type ModelStreamOutputKind = (typeof MODEL_STREAM_OUTPUT_KINDS)[number];
```

- 單一來源：schema 以 `z.enum(MODEL_STREAM_OUTPUT_KINDS)` 推導，不另寫字面值。
- 經 `src/index.ts` 具名匯出：`MODEL_STREAM_OUTPUT_KINDS` 加入 runtime 匯出區塊，`ModelStreamOutputKind` 加入 type 匯出區塊，維持字母序與既有分組。
- `api-surface.json`：`runtime` 加入 `MODEL_STREAM_OUTPUT_KINDS`，`types` 加入 `ModelStreamOutputKind`，維持排序。

替代方案：不匯出常數、只在 schema 內寫 `z.literal("answer_text")`。不採用：消費端無法取得單一來源，未來新增種類時會出現平行清單。

### D2：model.stream payload schema（contracts）

```ts
"model.stream": z.object({
  delta: z.string().max(65_536),
  messageId: opaqueIdSchema.optional(),
  outputKind: z.enum(MODEL_STREAM_OUTPUT_KINDS).optional(),
  textOffset: z.number().int().nonnegative().safe().optional(),
}).strict(),
```

- `messageId` 沿用模組內既有 `opaqueIdSchema`（trim、1–256），與其他事件的識別碼一致，不另定長度。
  - 注意：`opaqueIdSchema` 含 `.trim()`，Zod 會回傳去除前後空白的值。為符合 spec「值原樣保留」，測試只使用不含前後空白的合法值；含前後空白的輸入屬於輸入正規化，不視為改寫語意。若審查認為必須拒收含前後空白的值，改為 `z.string().min(1).max(256).regex(/^\S(?:.*\S)?$/)` 並於本 design 記錄。
- `textOffset` 使用 `.int().nonnegative().safe()`，對齊既有 `sequence` 的 `.int().positive().safe()` 寫法；`NaN`、`Infinity`、小數、負數、超過安全整數皆被拒。
- 三個欄位各自 `.optional()`，不加 `.default()`，不使用 `z.coerce`。
- 維持 `.strict()`；`delta` 定義不變。
- `RuntimeEventPayload` 型別由 `z.infer` 自動擴充，不手寫。

替代方案 A：三欄位以 `z.discriminatedUnion` 或 `superRefine` 強制「全有或全無」。不採用：會讓逐步升級的 producer 失敗，也把消費端的「是否當作正文」語意放進契約層。chat-gun 已在 `stream-chat-answer-text` 的 `runtime-event-contract` 規格規定「三者與合法 `delta` 齊備才進入正文路徑」。

替代方案 B：`.passthrough()`。不採用：違反 strict 契約與本 Change 非目標。

### D3：kernel 不改程式，只補測試

kernel 兩個入口都委派 contracts schema，擴充後自動生效。新增測試鎖定行為（見 D6），避免未來在 kernel 加入白名單時剝除欄位。

### D4：版本與 schemaVersion

- contracts、kernel、sdk、testkit 一起升為 `0.1.0-alpha.4`；kernel、sdk、testkit 對其他 harness 套件的相依改為 `0.1.0-alpha.4`；root lockfile 同步。
- `RUNTIME_EVENT_SCHEMA_VERSION` 維持 `"1.0.0"`，依 alpha.3 前例。理由：envelope 結構不變；payload 擴充為選用欄位；版本相容性由套件精確版本與 chat-gun 的功能開關管理。CHANGELOG 必須明載「alpha.3 以前的 strict 消費端不接受帶新欄位的 payload，producer 只能在消費端升級後發送」。
- 此項列為 Open Question 1，由 Master 確認。

### D5：CHANGELOG

四個套件的 `CHANGELOG.md` 新增 `## 0.1.0-alpha.4`：

- contracts：新增 `MODEL_STREAM_OUTPUT_KINDS`／`ModelStreamOutputKind`；`model.stream` payload 新增選用 `messageId`、`outputKind`、`textOffset`，各自驗證，未知欄位仍拒收；schema version 維持 1.0；舊版 strict 消費端相容性說明；為 Chat Gun `stream-chat-answer-text` 準備，經 Master 授權。
- kernel、sdk、testkit：相依升為 alpha.4，無行為變更（kernel 補欄位保留測試）。

### D6：測試計畫（`node:test`，與原始碼同目錄）

contracts（`packages/contracts/src/contracts.test.ts` 新增 `describe("model.stream payload")`）：

1. 只有 `delta`：通過，結果的 key 只有 `delta`。
2. 完整三欄位（`messageId: "message-1"`、`outputKind: "answer_text"`、`textOffset: 0`）：通過，值相等。
3. 只有 `delta` + `messageId`：通過。
4. 未宣告欄位（例如 `unexpected: true`）：失敗，issue code 為 `unrecognized_keys`。
5. 不合法值，逐一一案：`messageId` 為 `""`、`"   "`、257 字元、數字；`outputKind` 為 `"reasoning"`、`""`；`textOffset` 為 `-1`、`1.5`、`Number.NaN`、`Number.POSITIVE_INFINITY`、`Number.MAX_SAFE_INTEGER + 1`、字串 `"0"`。全部失敗。
6. `delta` 長度 65,537 且身分欄位合法：失敗。
7. 以 `MODEL_STREAM_OUTPUT_KINDS` 逐值驗證皆通過。

contracts API surface：既有 `src/api-surface.test.ts` 在更新 `api-surface.json` 後須通過；不更新時必須失敗（以實際執行確認）。

kernel（`packages/kernel/src/kernel.test.ts` 新增 `describe("model.stream answer identity")`）：

8. `parseRuntimeEventPayload("model.stream", payload)` 保留三欄位。
9. `parseRuntimeEventEnvelope()` 後以其 `type`、`payload` 呼叫 `parseRuntimeEventPayload()`，三欄位保留。
10. `textOffset: -1` 時 `parseRuntimeEventPayload` 拋錯。

testkit：若既有 fixture 測試涵蓋 envelope 透傳，新增一案帶三欄位的 `model.stream` payload 經 fixture 後值不變；若 fixture 不涉及 payload 驗證，記錄「不受影響」與依據。

### D7：發布前驗證與交回點

Codex 依序執行並保存輸出：

1. `npm ci`
2. `npm run check`
3. 各套件 `npm pack --dry-run`，確認 tarball 含 `dist` 與型別宣告。
4. clean install：在拋棄式目錄以四個 tarball 安裝 testkit，執行 `npm ls @gun-ai/harness-contracts`，確認只有 `0.1.0-alpha.4` 一份。
5. 以 tarball 執行 D6 第 2、4、5（`textOffset: -1`）案的 probe，作為發布前證據。

完成後停在發布前，交回 CCR 與 Master。Agent MUST NOT 執行 `npm publish`、`npm dist-tag` 或推送 tag。

## 發布與回滾

1. Master 核准後，依 contracts → kernel → sdk → testkit 順序以 `alpha` dist-tag 發布。
2. 發布後以匿名環境 `npm view @gun-ai/harness-contracts@0.1.0-alpha.4` 與安裝確認可取得。
3. 結果交回 CCR，CCR 建立 `stream-chat-answer-text` 新的 apply-change Handoff（Task 1.7）。
4. 回滾見 proposal。

## 安全

- 新欄位不承載 Secret；`messageId` 為不透明識別碼，長度受限。
- strict 維持，不擴大可注入欄位。
- 驗證失敗不回傳部分結果，不以型別轉換修正輸入。

## Risks / Trade-offs

- `messageId` 的 `.trim()` 正規化（D2 注意事項）。
- schemaVersion 不升版的相容性取捨（D4、Open Question 1）。
- 四套件同步升版會讓 sdk、testkit 出現「無行為變更」的版本，換取相依樹一致。

## Open Questions

1. **`RUNTIME_EVENT_SCHEMA_VERSION` 是否維持 `1.0.0`**：CCR 建議維持（alpha.3 前例、envelope 不變、版本由精確套件版本管理）。若 Master 要求升為 `1.1.0`，需另外評估 chat-gun 與 kernel 的版本相容檢查，並回到 PLAN_DRAFT 修訂。
2. **gun-harness 施工基準分支**：目前 checkout 為 `v0.0.3/feat/deduplicated-governed-outcome-alpha.3` @ `3d9f25f`。請 Master 指定從哪個分支切出施工分支（建議以已發布 alpha.3 的提交為基準）。
