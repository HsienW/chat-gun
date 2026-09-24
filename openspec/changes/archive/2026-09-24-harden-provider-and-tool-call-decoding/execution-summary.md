# Execution Summary

## 實際完成內容與 Design 差異

本 Change 完成 T1–T9：新增有界 typed JSON decode、provider envelope runtime validation、standalone stream assembler、Tool argument schema validation 與最多一次的 configured repair；decode failure 具 stable category 且不進入 generic retry／fallback，診斷資料採 allowlist redaction。35/35 checklist items 已完成。

實作與 Design 沒有未核准差異。`BoundedJsonStreamAssembler` 依原 scope 維持 standalone module，未接入 production provider streaming；production streaming integration 明確留在後續 Change。

Qwen `review-result` 判定 `APPROVE`（0 Blocker、0 Major、0 Minor），CCR `readiness-check` 判定 `READY_TO_ARCHIVE`。CurrentState 的三項既有 Major blocker 均已 resolved。

## 主要修改檔案

- `backend/src/platform/json-decode.ts`、`stream-assembler.ts`：有界 JSON decode 與增量組裝。
- `backend/src/platform/provider-envelope.ts`、`llm-gateway.ts`：provider envelope validation、Tool argument decode、repair 與 pre-dispatch rejection。
- `backend/src/platform/provider-error-category.ts`、`errors.ts`、`runtime-config.ts`：stable error category、typed errors 與有界設定。
- `backend/src/platform/*.test.ts`、`backend/src/agents/mcp-agent.tool-calling.test.ts`：單元、property、契約及回歸測試。
- `openspec/specs/provider-tool-call-decoding/spec.md`：由 delta spec 同步建立的 main capability spec。
- `openspec/changes/archive/2026-09-24-harden-provider-and-tool-call-decoding/`：保留 proposal、design、delta spec、tasks 與本摘要。

完整實作檔案清單與驗證摘要位於 `.agent-runtime/harden-provider-and-tool-call-decoding/evidence/`；該區域為 latest-only，不納入 Git。

## 驗證結果

- Backend lint 通過（exit 0）。
- Backend full test 通過：159 files passed、5 skipped；1129 tests passed、45 skipped。
- Backend build 通過（exit 0）。
- Targeted platform／tool-dispatch／agent regression、Weather／MCP golden 與 mock regression 均通過。
- Qwen review 為 `APPROVE`；CCR readiness gate 為 `READY_TO_ARCHIVE`。
- `openspec validate harden-provider-and-tool-call-decoding --strict` 與 `openspec validate provider-tool-call-decoding --type spec --strict --no-interactive` 均通過。
- Delta 與 main spec 正規化比對完全等價；35 項 checklist 全數完成，0 項未完成。
- 未執行真實 provider live smoke；45 個 environment-gated 或 opt-in tests 維持 skipped。

## 接受的風險與理由

- 未取得真實 provider live 驗收。Mock、golden、cross-layer contract 與全套非 live tests 已通過；live 驗證需具憑證且允許網路的環境。
- `BoundedJsonStreamAssembler` 尚未接線 production streaming。這符合 Change 明確 scope，且 push／end／abort、UTF-8 chunk、deadline、cancel、byte／depth limits 已有 deterministic tests。

## 未完成項目

- 真實 provider live smoke 與 production streaming integration 留待後續 Change。
- Git commit／push 由人工執行；本 Change 在人工 commit 前維持 `ARCHIVED_AWAITING_HUMAN_COMMIT`、`NON_TERMINAL`。

## 重要決策與取捨

- Malformed Tool argument 不再以 `{}` 靜默降級；只有合法空物件可通過 decode，且仍須通過 Tool input schema。
- `provider_decode_failure` 不具 fallback 資格且不進 invoke retry；只有符合條件的 configured repair 可最多嘗試一次。
- `too_large` 保留 `byteLength` 與 stable `errorCode`，不計算 `rawHash`，避免對超限 payload 增加 CPU amplification。
- Provider envelope 對必備欄位 fail-closed，未知額外欄位則 passthrough，以兼顧安全與 forward compatibility。

## Commit 建議

`chore(openspec): archive provider tool-call decoding hardening`

內文建議：同步 `provider-tool-call-decoding` main spec，歸檔 `harden-provider-and-tool-call-decoding` Change 與 execution summary，並保留 backend lint／build 及 1129 tests passed 的驗證結論。由人工檢查 staged diff 後執行 commit／push。

`OpenSpec Change: harden-provider-and-tool-call-decoding`

`Co-Authored-By: Claude <noreply@anthropic.com>`
