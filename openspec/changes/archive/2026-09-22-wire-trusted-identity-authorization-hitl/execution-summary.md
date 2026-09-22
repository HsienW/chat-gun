# Execution Summary

## 實際完成內容與 Design 差異

- 完成 production Tool authorization composition root，將 local tools 與 MCP tools 接入 fail-closed governance、versioned policy identity、persistent decision store 與 durable confirmation bridge。
- 完成 BFF trusted principal 與唯一 active scope 的解析及 canonical `x-bff-*` header projection；backend 僅由可信 header 建立 `PrincipalContext` 與 `RuntimeScope`。
- 完成 LangGraph `confirmation_required` interrupt/resume 流程、persistent waiting state、256-bit CSPRNG approval ID、atomic compare-and-set consumption，以及 tenant/run/resource/policy binding validation。
- 完成 authorization decision 與 `ToolExecution` linkage，並讓 deny、timeout 與 authorization unavailable 結果不進入一般 retry budget。
- 實作內容未縮減已核准 Design；live deployment 驗證仍依原計畫延後，並保留兩項 reviewer 接受的 Low 風險。

## 主要修改檔案

- `backend/src/tools/authorization/`：production authorization composition、MCP risk descriptor 與 architecture tests。
- `backend/src/platform/tool-governance.ts`：authorization gate、typed confirmation descriptor 與 fail-closed dispatch。
- `backend/src/runtime/authorization/confirmation.ts`、`confirmation-graph.ts`：durable confirmation persistence 與 LangGraph interrupt/resume。
- `backend/src/runtime/persistence/migrations/018_create_authorization_confirmations.sql`：authorization confirmation schema。
- `backend/src/runtime/side-effect/`：decision-to-execution linkage 與 retry exclusions。
- `backend/langgraph.json`、`backend/src/runtime/execution-context/`：trusted header allowlist 與 execution-context projection。
- `bff/src/config.ts`、`bff/src/identity.ts`、`bff/src/server.ts`：trusted profile、active scope 與 header forwarding。
- `contracts/execution-context.fixture.json`：BFF/backend cross-layer contract fixture。
- `README.md`、`README.en.md`、`docs/bff.md`、`docs/bff.en.md`：active scope configuration guidance。

## 驗證結果

- Backend lint、deterministic tests 與 build 通過；測試結果為 145 個 test files 通過、6 個略過，1018 個 tests 通過、46 個略過。
- Backend confirmation targeted tests 通過：2 個 test files、11 個 tests。
- BFF tests 與 build 通過：7 個 Vitest files／70 個 tests，加上 1 個 `node:test` file。
- Qwen implementation review 結果為 `APPROVE`，無 Blocker、無 Major，2 個 Low findings 已接受。
- OpenSpec tasks T1–T9 全部完成，未勾選數量為 0。
- Archive 已同步 `trusted-tool-authorization` main spec；`npx.cmd openspec validate --all --strict` 結果為 38 passed、0 failed。
- `git diff --check` 通過。

完整 deterministic validation evidence 保存在 `.agent-runtime/wire-trusted-identity-authorization-hitl/evidence/`。

## 接受的風險與理由

- 尚未執行 deployed Agent Server interrupt/resume E2E 與 production checkpoint restart/recovery smoke；兩者需要 live deployment。現階段以 deterministic graph、persistence、CAS 與 contract tests 覆蓋核心不變量。
- Live Opik evaluation 因外部網路不可用而未完成；deterministic suite 已通過，live evaluation 留待可連線環境執行。
- Confirmation audit sink failure handling 為 Low observability risk；資料庫授權狀態先完成持久化，不影響 authorization correctness。
- `resolveScopeAccess` 目前採同 tenant 即 writable 的簡化模型；此行為已由 Design 接受，未來可用獨立 change 加入 role／scope-type 細分。
- Archived proposal 使用舊版章節名稱，CLI 回報缺少標準 `Why`／`What Changes` 標題的非阻斷警告；規格 delta、tasks 與 strict validation 均完整通過。

## 未完成項目

- Deployed Agent Server interrupt/resume end-to-end validation。
- Production checkpoint restart/recovery smoke validation。
- Live Opik evaluation。
- Reviewer MIN-001 與 MIN-002 可由後續 OpenSpec change 處理，不阻擋本次 archive。

## 重要決策與取捨

- Production 預設 fail closed；development read default 必須由明確 profile／flag 啟用，不能僅依 `NODE_ENV=development` 繞過 authorization。
- MCP risk 使用 strict、versioned descriptor，並綁定實際 `serverName + toolName`；server description 或 annotations 不具有提權能力。
- `approvalId` 只作為高熵 correlation value，不視為 bearer credential；resume 仍必須驗證可信 principal、tenant、scope、run、decision、resource、policy version 與 expiry。
- Governance 只產生 serializable confirmation descriptor；只有具 checkpoint context 的 graph node 呼叫 `interrupt()`。
- BFF active scope 必須由 authentication profile 明確提供，不從 permission scopes、tenant default 或 anonymous identity 推測。
- Authorization decision 必須先於 physical dispatch 持久化，並可由 `toolExecutionId` 回溯。

## Commit 建議

```text
docs(openspec): archive trusted identity authorization HITL

- Sync the trusted tool authorization requirements into the main spec.
- Preserve the approved proposal, design, tasks, and delta spec in the dated archive.
- Record validation evidence, accepted risks, and deferred live checks.

OpenSpec Change: wire-trusted-identity-authorization-hitl
Co-Authored-By: Claude <noreply@anthropic.com>
```
