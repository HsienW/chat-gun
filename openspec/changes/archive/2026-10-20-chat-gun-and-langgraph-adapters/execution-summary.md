# Execution Summary

## 實際完成內容與 Design 差異

X28 依 Human 2026-10-20 核准的縮小範圍，完成 backend 私有 composition root、framework-neutral/reference adapter、LangGraph 身分／Step／checkpoint／approval／stream／retry／cancel 映射。全部 17 個 active Tasks 完成。

實作不建立第二個 authorization、tool executor、ledger、scheduler 或 terminal owner，不新增 harness public export、公開 Graph ID、BFF route 或 event schema。正式四 Graph 接線與部署屬後續工作，原 Design 的 production migration 步驟尚未執行。

## 主要修改檔案

- composition：`backend/src/operations/runtime-composition.ts` 與配對測試。
- adapters：`backend/src/runtime/framework-adapters/`、共用 checkpoint metadata／boundary。
- identity／approval／ledger：graph-entry/admission、confirmation consume gate、真實 PostgreSQL native retry integration。
- Scenario 對照：`backend/src/operations/x28-scenario-evidence.md`；參考範例：`x28-reference-examples.md`。
- 本目錄保存 proposal/design/tasks/三份 delta specs，並將三個新增能力同步至 `openspec/specs/`。

## 驗證結果

| 範圍 | 已實際取得的證據 |
| --- | --- |
| backend 最終回歸 | 275 passed files；2,095 passed、36 skipped；lint 的 22 additive checks 與 build 通過 |
| PostgreSQL | 本機 Docker PostgreSQL integration；ledger 11 tests，含 committed/ambiguous native retry，實體副作用各一次 |
| owning gun-harness repo | package check／build／typecheck／34 tests 通過 |
| BFF | 10 tests 與 build 通過 |
| frontend | 180 tests、lint、build 通過；既有 chunk size warning 不阻斷 |
| consumer provenance | 四個固定版 harness alpha.2 套件 clean registry consumer 安裝、import 及 resolved/integrity 核對通過 |
| review | 已保存的 Qwen review-result 為 APPROVE，無 Blocker／Major／Minor |
| readiness | Human 明確授權 Codex 代行 Coordinator，按本 change 完成定義通過 implementation/readiness |

readiness 本輪比對全部 44 個送審檔案 SHA-256，與已驗證版本一致；未重跑上述程式測試，未宣稱本輪重新執行。OpenSpec strict 與 git diff --check 已於歸檔前重新執行通過。歸檔後檢查記錄見下方 Archive 核對。

## 接受的風險與理由

- 這是私有能力的 composition deliverable 結案，production-ready 與 sandbox-ready 均為 false。
- 36 個 opt-in live tests 略過；真實 Provider、正式 Agent Server／PostgreSQL／Redis 拓撲、Linux/macOS 與 live isolation 尚未驗證。
- mock／MemorySaver／本機 PostgreSQL 證據不取代正式 persistence、isolation 或部署驗證。
- 工作區另有 sandbox-execution-runtime 修改；本次歸檔與 commit 清單必須排除該 change。

## 未完成項目

| 原 Task | 本次狀態 | 承接責任 |
| --- | --- | --- |
| T2.2b | 延期、維持未勾選；不阻擋 X28 已核准 deliverable 結案 | 後續 composition-publication change：四 Graph 正式 composition 接線／production publication |
| T5.1 | 延期、維持未勾選 | 後續 composition-publication change：正式 Agent Server live drills／failure recovery |
| T5.2 | 延期、維持未勾選 | 後續 composition-publication change：逐 Graph rollout／rollback |
| concrete isolated_process runner | 不屬 X28 交付 | sandbox-execution-runtime |

composition-publication 是規劃的承接 change，本文件不宣稱它已建立。上述正式驗證與發布禁令持續有效，其完成不再作為回頭解除 X28 lifecycle gate 的前提。任何新 runtime 行為或公開化仍需獨立提案、審查與驗證。

## 重要決策與取捨

1. 私有 port 先行；CheckpointAdapterMetadataV1 引用既有 ExecutionManifestRef／RuntimeVersionSet，不新增平行 public/version authority。
2. 產品 runId 由受信 admission 建立／恢復，native run_id 僅保留 private correlation。
3. approval 的 physical dispatch 必須經既有 manifest consume gate；native retry 必須遵守 ledger 與 indeterminate reconciliation。
4. 前次 readiness 以已移出完成門檻的 production Tasks 阻擋 X28，與 proposal dependency 段／tasks §6 矛盾，並引用目前 AGENTS.md §11 不存在的文字。Human 明確授權 Codex 接手協調；依已核准範圍修正判定，未修改 Qwen 原文或放寬 runtime 安全要求。
5. 舊 proposal/tasks 內「待 Qwen」「最終 gate 維持 false」是對當時階段的記錄；本次 Qwen APPROVE 與 scope-specific readiness 已完成。Archive 不代表 production 發布。

## Commit 建議

建議訊息：

`feat(runtime): add private composition and LangGraph adapters`

人工只 stage 下列清單，勿使用 `git add .`；不要將 `.agent-runtime/` 加入 Git。尚未執行 git add／commit／push。

```text
backend/src/agents/deep-researcher.turn-evidence.test.ts
backend/src/agents/mcp-agent.tool-calling.test.ts
backend/src/platform/tool-governance.test.ts
backend/src/runtime/execution-context/graph-entry.ts
backend/src/runtime/execution-context/graph-entry.test.ts
backend/src/runtime/execution-context/graph-task-admission.ts
backend/src/runtime/execution-context/graph-task-admission.test.ts
backend/src/runtime/execution-context/instrument-graph.ts
backend/src/runtime/execution-context/graph-entry.langgraph.integration.test.ts
backend/src/runtime/framework-adapters/bounded-operation.test.ts
backend/src/runtime/framework-adapters/bounded-operation.ts
backend/src/runtime/framework-adapters/langgraph-stream-adapter.test.ts
backend/src/runtime/framework-adapters/langgraph-stream-adapter.ts
backend/src/runtime/framework-adapters/langgraph-task-observer.test.ts
backend/src/runtime/framework-adapters/langgraph-task-observer.ts
backend/src/runtime/framework-adapters/README.md
backend/src/runtime/framework-adapters/reference-adapter.test.ts
backend/src/runtime/framework-adapters/reference-adapter.ts
backend/src/runtime/framework-adapters/registry.test.ts
backend/src/runtime/framework-adapters/registry.ts
backend/src/runtime/persistence/adapter-checkpoint-boundary.ts
backend/src/runtime/persistence/adapter-checkpoint-boundary.test.ts
backend/src/runtime/persistence/checkpoint-adapter-metadata.ts
backend/src/runtime/persistence/checkpoint-adapter-metadata.test.ts
backend/src/runtime/persistence/checkpoint-fixture.testing.ts
backend/src/runtime/persistence/langgraph-adapter-checkpoint.integration.test.ts
backend/src/runtime/authorization/confirmation-graph.ts
backend/src/runtime/authorization/confirmation-graph.test.ts
backend/src/runtime/side-effect/business-effect-ledger.integration.test.ts
backend/src/runtime/side-effect/tool-execution-runner.test.ts
backend/src/runtime/tool-dispatch/pipeline.test.ts
backend/src/tools/mcp-loader.ts
backend/src/tools/mcp-loader.test.ts
backend/src/tools/mcp-result.ts
backend/src/operations/runtime-composition.ts
backend/src/operations/runtime-composition.test.ts
backend/src/operations/x28-reference-examples.md
backend/src/operations/x28-scenario-evidence.md
openspec/changes/archive/2026-10-20-chat-gun-and-langgraph-adapters/proposal.md
openspec/changes/archive/2026-10-20-chat-gun-and-langgraph-adapters/design.md
openspec/changes/archive/2026-10-20-chat-gun-and-langgraph-adapters/tasks.md
openspec/changes/archive/2026-10-20-chat-gun-and-langgraph-adapters/specs/framework-adapter-interface/spec.md
openspec/changes/archive/2026-10-20-chat-gun-and-langgraph-adapters/specs/langgraph-runtime-adapter/spec.md
openspec/changes/archive/2026-10-20-chat-gun-and-langgraph-adapters/specs/chat-gun-runtime-composition/spec.md
openspec/changes/archive/2026-10-20-chat-gun-and-langgraph-adapters/.openspec.yaml
openspec/changes/archive/2026-10-20-chat-gun-and-langgraph-adapters/execution-summary.md
openspec/specs/chat-gun-runtime-composition/spec.md
openspec/specs/framework-adapter-interface/spec.md
openspec/specs/langgraph-runtime-adapter/spec.md
```

## Archive 核對

本輪承接時，X28 已在本 Archive 目錄且三份主規格已同步，但 CurrentState 與 Archive Result 尚未收尾。本輪未重複搬移或覆寫規格。44/44 送審 SHA-256 一致；17 active Tasks 完成，3 項延期保持未勾選。

歸檔後重新驗證：三份主規格 strict 通過；13 Requirements／46 Scenarios 與 delta 完全一致；封存 delta 經正式 CLI 相同的 Validator(true).validateChangeDeltaSpecs(archivePath) 通過；git diff --check 通過。CurrentState、readiness、Archive Handoff 與本輪輸出均經 JSON Schema 驗證。本輪未重跑程式 lint/test/build。

額外診斷：舊 validateChange(proposalPath) helper 因超過 10 deltas 回報 false；查本機 CLI 原始碼確認正式入口為 validateChangeDeltaSpecs，以相同入口驗證通過，未修改或放寬規格。

Archive Result 與 Human Handoff 已保存於本機 Runtime。CurrentState 改為 ARCHIVED_AWAITING_HUMAN_COMMIT / Human / NON_TERMINAL。人工 commit 並保存證據後，才可轉成 COMPLETED / TERMINAL。
