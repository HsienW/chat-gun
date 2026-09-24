# Execution Summary

## 實際完成內容與 Design 差異

本 Change 完成 T1–T9，將既有 trusted identity、scope authorization、grant、decision persistence 與 Tool governance 原語接入 production dispatch：建立 authorization composition root、production Tool risk policies、BFF active scope projection、Agent Server canonical trusted-header allowlist，以及以 LangGraph interrupt 為邊界的一次性 scoped confirmation resume。33/33 checklist items 已完成。

實作與核准 Design 沒有未處理差異。Qwen `review-result` 判定 `APPROVE`（0 Blocker、0 Major、2 Minor Low），CCR `readiness-check` 判定 `READY_TO_ARCHIVE`。兩項 Minor 已接受為後續改進，不影響授權決策正確性。

Durable confirmation 跨 process restart 的正式部署行為仍屬「基於未驗證假設」：本 Change 以 deterministic tests 與 mock integration 證明契約，但沒有把它宣稱為 deployed Agent Server 的 live 證據。

## 主要修改檔案

- `backend/src/tools/authorization/`、`backend/src/tools/registry.ts`、`backend/src/tools/mcp-loader.ts`：production authorization composition root、Tool risk policy 與 MCP descriptor validation。
- `backend/src/runtime/authorization/confirmation.ts`、`confirmation-graph.ts`：persistent confirmation、atomic CAS、LangGraph interrupt／resume 契約。
- `backend/src/runtime/persistence/migrations/018_create_authorization_confirmations.sql`：authorization confirmation persistence。
- `backend/src/runtime/side-effect/`、`backend/src/platform/tool-governance.ts`：decision-before-dispatch、ToolExecution linkage 與 retry exclusion。
- `backend/langgraph.json`、`backend/src/runtime/execution-context/`：canonical trusted-header allowlist 與 execution context 解析。
- `bff/src/identity.ts`、`bff/src/server.ts`、`bff/src/config.ts`：trusted principal 與唯一 active scope resolution／projection。
- `openspec/specs/trusted-tool-authorization/spec.md`：由 delta spec 同步建立的 main capability spec。
- `openspec/changes/archive/2026-09-24-wire-trusted-identity-authorization-hitl/`：保留 proposal、design、delta spec、tasks 與本摘要。

完整實作檔案與驗證摘要位於 `.agent-runtime/wire-trusted-identity-authorization-hitl/evidence/`；該區域為 latest-only，不納入 Git。

## 驗證結果

- Backend lint、build 通過。
- Backend deterministic test：145 files passed、6 skipped；1018 tests passed、46 skipped。
- Backend targeted confirmation tests：2 files／11 tests 通過。
- BFF test：7 個 Vitest files／70 tests，加 1 個 `node:test` file 通過；BFF build 通過。
- Qwen review 為 `APPROVE`；CCR readiness 為 `READY_TO_ARCHIVE`。
- `openspec validate wire-trusted-identity-authorization-hitl --strict` 通過。
- `openspec validate trusted-tool-authorization --type spec --strict --no-interactive` 通過。
- Delta 與 main spec 正規化比對完全等價；33 項 checklist 全部完成，0 項未完成。
- Live Opik evaluation 因外部網路不可用而失敗；沒有宣稱 live 驗收通過。

## 接受的風險與理由

- Deployed Agent Server interrupt/resume E2E 與 production checkpoint restart/recovery 尚未取得 live L 證據；依 X11 約束延後至具正式部署環境的後續 Change。
- Live Opik evaluation 未完成；目前 deterministic suite 與 mock integration 已通過，需在具網路與憑證的環境補驗。
- MIN-001：confirmation audit sink 的非同步失敗可能遺失 observability event，但 DB authorization state 已提交，不影響安全決策。
- MIN-002：`resolveScopeAccess` 暫採 same-tenant writable 的簡化模型；risk policy 與 authorization decision 仍提供既有保護，細粒度 role／scope type 規則留待後續擴充。

## 未完成項目

- 在正式 Agent Server 執行 interrupt/resume、process restart 與 checkpoint recovery live smoke。
- 在可連線 Opik 的 CI／驗收環境重跑 live evaluation。
- 後續評估 audit sink fault isolation 與細粒度 scope-access rules。
- Git commit／push 由人工執行；本 Change 在人工 commit 前維持 `ARCHIVED_AWAITING_HUMAN_COMMIT`、`NON_TERMINAL`。

## 重要決策與取捨

- Production 未註冊 Tool、缺 trusted identity、缺 active scope 或 authorization dependency unavailable 一律 fail-closed。
- BFF 只投影 resolver 產生的 canonical identity／active scope；不從 permission scopes 或 client headers 猜測。
- `approvalId` 使用至少 256-bit CSPRNG，但不是 bearer credential；resume 同時綁定 principal、tenant/scope、run、decision、resource、policy version 與 expiry，並以 atomic CAS 一次性消耗。
- Authorization decision 必須先於 physical dispatch 持久化；deny、timeout 與 unavailable 不進 X2 Retry Budget。
- Governance 只產生 serializable `confirmation_required` descriptor；只有具 checkpoint context 的 graph node 呼叫 `interrupt()`。

## Commit 建議

`chore(openspec): archive trusted identity authorization HITL`

內文建議：同步 `trusted-tool-authorization` main spec，歸檔 `wire-trusted-identity-authorization-hitl` Change 與 execution summary，保存 backend／BFF deterministic 驗證結果，並明示三項 live 驗證仍待後續環境完成。由人工檢查 staged diff 後執行 commit／push。

`OpenSpec Change: wire-trusted-identity-authorization-hitl`

`Co-Authored-By: Claude <noreply@anthropic.com>`
