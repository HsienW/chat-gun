# Execution Summary

## 實際完成內容與 Design 差異

本 Change 已於 Asia/Taipei 2026-11-14 歸檔。生成預設統一為 qwen3.5-flash，Gateway 依 capability 明確送出 thinking；Gun Shop 禁止開啟 thinking。評測新增原始 provider 模型與 endpoint 來源紀錄，保留既有 model metadata 與舊 provenance 相容性。模型切換的 Tool、事件及錯誤碼證據已由 apply-change-005 補齊。archive 階段只同步規格、補 Tasks 說明與建立本摘要，沒有修改產品程式。

## 主要修改檔案

以下是精確 commit path 清單，共 40 個路徑：27 個產品／測試／設定檔、5 個原 active Change 刪除路徑、2 份新主規格、6 個 archive 文件。刪除路徑是移動 Change 所需，不是額外內容。

- backend/.env.example
- backend/src/agents/shopping-assistant/model-settings.test.ts
- backend/src/agents/shopping-assistant/model-settings.ts
- backend/src/evaluation/commerce/chain-live-dependencies.ts
- backend/src/evaluation/commerce/chain-report.ts
- backend/src/evaluation/commerce/evaluate.cli.ts
- backend/src/evaluation/commerce/generation-models.test.ts
- backend/src/evaluation/commerce/generation-models.ts
- backend/src/evaluation/commerce/order-request-golden.cli.ts
- backend/src/evaluation/commerce/order-request-golden.test.ts
- backend/src/evaluation/commerce/order-request-golden.ts
- backend/src/evaluation/generation-env.test.ts
- backend/src/evaluation/generation-provenance.test.ts
- backend/src/evaluation/generation-provenance.ts
- backend/src/evaluation/qwen-flash-probe.live.test.ts
- backend/src/evaluation/qwen-flash-probe.test.ts
- backend/src/evaluation/qwen-flash-probe.ts
- backend/src/knowledge/evaluation/evaluate-generation.test.ts
- backend/src/knowledge/evaluation/evaluate.cli.ts
- backend/src/knowledge/evaluation/report.ts
- backend/src/platform/generation-model-graphs.test.ts
- backend/src/platform/generation-model-profile.test.ts
- backend/src/platform/generation-model-profile.ts
- backend/src/platform/llm-gateway.test.ts
- backend/src/platform/llm-gateway.ts
- backend/src/platform/llm-gateway.usage.test.ts
- backend/src/platform/runtime-config.ts
- openspec/changes/archive/2026-11-14-switch-generation-to-qwen35-flash/design.md
- openspec/changes/archive/2026-11-14-switch-generation-to-qwen35-flash/execution-summary.md
- openspec/changes/archive/2026-11-14-switch-generation-to-qwen35-flash/proposal.md
- openspec/changes/archive/2026-11-14-switch-generation-to-qwen35-flash/specs/evaluation-model-provenance/spec.md
- openspec/changes/archive/2026-11-14-switch-generation-to-qwen35-flash/specs/generation-model-profile/spec.md
- openspec/changes/archive/2026-11-14-switch-generation-to-qwen35-flash/tasks.md
- openspec/changes/switch-generation-to-qwen35-flash/design.md
- openspec/changes/switch-generation-to-qwen35-flash/proposal.md
- openspec/changes/switch-generation-to-qwen35-flash/specs/evaluation-model-provenance/spec.md
- openspec/changes/switch-generation-to-qwen35-flash/specs/generation-model-profile/spec.md
- openspec/changes/switch-generation-to-qwen35-flash/tasks.md
- openspec/specs/evaluation-model-provenance/spec.md
- openspec/specs/generation-model-profile/spec.md

下列工作目錄項目明確排除於本 Change commit，不應一併 stage：

- backend/package-lock.json
- backend/package.json
- backend/src/runtime/index.ts
- frontend/package-lock.json
- frontend/package.json
- openspec/changes/isolate-backend-test-environment/tasks.md
- openspec/changes/stream-chat-answer-text/design.md
- openspec/changes/stream-chat-answer-text/proposal.md
- openspec/changes/stream-chat-answer-text/tasks.md
- backend/data/knowledge-eval/results/kb-eval-v1-2026-10-27/comparison-dev.md
- backend/data/knowledge-eval/results/kb-eval-v1-2026-10-27/comparison-test.md
- backend/data/knowledge-eval/results/kb-eval-v1-2026-10-27/manual-inspection-template.json
- backend/data/knowledge-eval/results/kb-eval-v1-2026-10-27/provenance.json
- backend/data/knowledge-eval/results/kb-eval-v1-2026-10-27/run-vector_only.json
- backend/data/knowledge-eval/results/kb-eval-v1-2026-10-27/run-vector_rerank.json
- backend/src/runtime/stream-answer-contract-gate.test.ts
- backend/src/stream-chat-answer-text-gate/custom-writer-bridge.gate.test.ts
- backend/src/stream-chat-answer-text-gate/live/.gitignore
- backend/src/stream-chat-answer-text-gate/live/custom-gate-graph.ts
- backend/src/stream-chat-answer-text-gate/live/langgraph.json
- chat-response-streaming-plan.md
- frontend/e2e/stream-chat-answer-text/mock-provider.mjs
- frontend/src/lib/stream-answer-sdk-gate.test.tsx
- openspec/changes/stream-chat-answer-text/specs/model-usage-ledger/spec.md

.agent-runtime/** 為本機 ignored 證據，不列入 commit；backend/package.json、lockfile、frontend、runtime/index 與其他 Change 文件皆已排除。

## 驗證結果

- readiness-result-003：lint、build、strict validate 通過；完整 test 2433 passed、118 skipped、0 failed，無外部測試並行。
- archive 前：openspec validate switch-generation-to-qwen35-flash --strict 通過。
- 兩份新主規格保留全部 delta Requirement／Scenario 原文，共 11 Requirements、46 Scenarios。
- archive CLI：16/18 Tasks；依 Master 決策以 --yes 接受兩項未勾選。兩份 spec 已先同步，--skip-specs 僅避免重複套用。
- archive 後：openspec validate --specs --strict --no-interactive --json 通過；兩份新 spec 各自 strict validate 也通過。
- CLI 的 Why 長度與 delta 數量提示均為 non-blocking warning，未為消除提示修改已接受設計。
- CLI 使用 UTC 日期產生 2026-11-13 目錄，只將本次新目錄正規化為 Master／使用者時區的 2026-11-14。
- archive 本輪未重跑 backend lint/test/build；本輪只修改 OpenSpec 與文件。

## 接受的風險與理由

- Qwen Minor：2.5 的 provider_model 空字串語意修訂未經 review-plan；review-result 已覆蓋修訂後 spec，readiness 接受並保留紀錄。
- review-result 的 evidence gate 因 raw_output_contains_secret 未通過；CCR 查證為原始碼識別字／模板誤判，Master 於 2026-11-13 人工驗證接受。不得將此記錄改寫為 adapter 自動 gate 通過。
- 0.3 程序偏差：2.3、2.6 施工前未逐 Task 保存 Gate 命令輸出，已於 readiness-result-001／003 接受；仍未勾選，不追補或捏造歷史證據。
- 3.3 live 未驗證；Master 2026-11-14 決定先 archive，執行時機由 Master 決定。text、json_object、tool_calling、vision、thinking_off 的新加坡 live 相容性不宣稱已通過。
- 歷史測試逾時與後續 mock／帳本金額失敗的根因未證實。CCR 已接受 apply-change-006 的 B 觀察性判定；不能宣稱已證明歷史外部測試並行是唯一原因。
- CCR 以 implementation_secondary 完成 apply-change-003、004；Codex 完成 001、002、005 與 006 取證。第三輪 readiness 由 Codex 依 auth-switch-generation-readiness-codex-003 的 self_acceptance 授權驗收。

## 未完成項目

- 0.3 與 3.3 保持未勾選；不因此宣稱所有 Tasks 完成。
- 尚未 commit／push；本次沒有切換分支、stash、reset，未啟動 Qwen 或 adapter，也未執行 live probe。
- 下游品質評測、正式單價及新加坡部署仍由各自 Change 負責。

## 重要決策與取捨

Master 已決定先 archive，live 時機後定；historical Gate 缺漏與 flaky 根因限制永久保留於本摘要。archive 只同步兩份新能力，不修改其他主規格。Runtime Artifact 引用會隨 CurrentState 更新至 archive 路徑；ignored 證據不應加入版本控制。

## Commit 建議

```text
feat(backend): 將預設生成模型切換至 qwen3.5-flash

- 統一生成模型預設與 capability thinking 控制，Gun Shop 一律關閉 thinking
- 評測記錄 provider 原始模型、thinking 與 endpoint，保留舊 provenance 相容性
- 補足模型切換契約與回滾驗證，歸檔 OpenSpec 並保留已接受限制
```
