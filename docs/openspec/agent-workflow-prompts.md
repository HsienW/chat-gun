# OpenSpec Agent Workflow Prompts

本文件是本專案 OpenSpec 多 agent 流程的入口說明。各 agent runtime 都必須在任務開始前感知本 workflow-router；完整階段模板目前由 Codex skill 保存，Qwen 與 Claude 以宿主專屬 wrapper 接入同一套路由。

```text
.codex/skills/openspec-workflow-router/
.qwen/skills/openspec-workflow-router/
.claude/skills/openspec-workflow-router/
```

目的：

- 用短 prompt 觸發正確流程，避免每次載入 7 組完整模板。
- 讓 Codex 依階段漸進讀取對應 reference。
- 讓 Qwen 與 Claude 在自己的 runtime 入口先判斷 stage，再轉入 reviewer 或 coordinator 職責。
- 讓 CCR、Qwen Reviewer、Codex 在 OpenSpec change lifecycle 中使用一致交接語言。

## 角色對應

| 流程角色 | 主要 | 次要（需 Master 逐次授權，rolePolicyVersion 2） | 責任 |
| --- | --- | --- | --- |
| Planner | CCR | Codex | 前期需求評估，產生 proposal / design / tasks 草案 |
| Reviewer | Qwen | 無 | 審查計劃與實作結果，找 Blocker / Major / Minor |
| Implementer | Codex | CCR | 依 OpenSpec 實作、測試、更新 tasks |
| Coordinator | CCR | Codex | 完成判定；不得驗收自己撰寫的實作（Master self_acceptance 例外） |
| Archivist | Codex + 人工 | CCR + 人工 | 執行 OpenSpec archive；git commit / push 由人完成 |

沒有 `rolePolicyVersion` 的既有紀錄依 v1（只有主要角色）解讀。完整規則見 `openspec/specs/agent-role-policy/spec.md`。

## 寫入前角色 Gate

任何 Agent 在每一次寫入前都必須重新驗證 `role + currentPhase + currentOwner + target path + Handoff`。宿主具備 Write、Edit、Shell 或 MCP 能力不等於目前角色有權使用；改動只有一行、使用者接受決策方向或 Coordinator 想節省交接時間都不得豁免。

驗證失敗、狀態缺失或任務由查詢／審查滑向實作時，Agent 必須 fail-closed，只產出 Structured Handoff，不得修改任何字。CCR 的實作 Handoff 預設交給 Codex；只有在 v2 且有有效 Master 授權時，CCR 才能以 implementation_secondary 承接；

## 階段路由

| 階段 | 使用時機 | Skill reference |
| --- | --- | --- |
| 1. plan-change | 需求尚未形成 OpenSpec change | `.codex/skills/openspec-workflow-router/references/01-plan-change.md` |
| 2. review-plan | proposal / design / tasks 需要先審 | `.codex/skills/openspec-workflow-router/references/02-review-plan.md` |
| 3. apply-change | OpenSpec 計劃已通過，交給 Codex 實作 | `.codex/skills/openspec-workflow-router/references/03-apply-change.md` |
| 4. review-result | Codex 完成後交給 Qwen 審查 | `.codex/skills/openspec-workflow-router/references/04-review-result.md` |
| 5. fix-from-review | Qwen 找到 Blocker / Major / Minor 後交回 Codex | `.codex/skills/openspec-workflow-router/references/05-fix-from-review.md` |
| 6. readiness-check | Codex 修完且 Qwen 通過後，CCR 做完成判定 | `.codex/skills/openspec-workflow-router/references/06-readiness-check.md` |
| 7. archive-change | 完成判定通過後，啟動 archive 與 commit message 建議 | `.codex/skills/openspec-workflow-router/references/07-archive-change.md` |

## 建議短 Prompt

使用 Codex 時，優先用 skill route：

```text
使用 openspec-workflow-router，對 {change_name} 做 {stage}。
必要上下文如下：
{context}
```

範例：

```text
使用 openspec-workflow-router，對 weather-cjk-geocoding-query-name 做 review-result。
Codex 摘要如下：
...
修改檔案如下：
...
驗證結果如下：
...
```

使用 Qwen Reviewer 時，優先用 Qwen router：

```text
使用 openspec-workflow-router，對 {change_name} 做 {stage} 唯讀審查。
必要上下文如下：
{context}
```

使用 Claude／CCR 時，優先用 Claude router：

```text
使用 openspec-workflow-router，對 {change_name} 做 {stage} 協調。
必要上下文如下：
{context}
```

## 上下文策略

預設只讀最小必要內容：

- 相關 OpenSpec artifacts。
- 使用者提供的 diff / 摘要 / 驗證結果。
- 直接受影響的檔案與相鄰測試。
- 必要的 AGENTS.md 規則片段。

預設不要讀取：

- `.gitignore` 已忽略的內容。
- `node_modules/`、`dist/`、`build/`、`coverage/`。
- lockfile，除非本 change 涉及 dependency 變更。
- 大量無關檔案或完整遞迴輸出。

只有在以下情況才擴大讀取：

- OpenSpec、程式碼或專案規則互相衝突。
- 變更涉及跨層契約、安全、權限、資料格式或 migration。
- 測試失敗且無法用相鄰上下文定位。
- Reviewer finding 指向更上游的架構問題。

## Artifact-based Shared State

已知 Change 名稱時，Router 先讀取精確路徑 `.agent-runtime/<change-id>/current-state.json`。`currentPhase` 決定唯一 Stage，`currentOwner` 決定寫入者；聊天摘要只用於發現衝突，不覆蓋 CurrentState。

各 Stage 的輸入只來自 `latestArtifactRefs` 與目前 Handoff 的 `requiredInputRefs`。讀取前驗證 changeId/runId、安全相對路徑、檔案存在與無 Secret；不得遞迴掃描 `.agent-runtime/` 或讀取其他 Change／Run。

每個 Stage 產生一份 latest-only Result 與 Handoff，再由有寫入權的 Agent、人工或 CLIHost 更新 CurrentState。Qwen 只輸出 JSON／Markdown，不直接寫入。結構化 JSON 是機器可讀來源；Markdown 是同一結果的人類可讀投影。

## Qwen Review 啟動規範（強制使用 adapter wrapper）

Qwen 的 review-plan 或 review-result 階段 MUST 由 `qwen-capture-adapter.mjs` wrapper 啟動，不得直接呼叫 Qwen CLI：

```bash
node tools/qwen-capture-adapter.mjs \
  --change-id <change-id> \
  --run-id <run-id> \
  --artifact-id <unique-artifact-id> \
  --stage review-result \
  --output-format stream-json \
  --expected-auth-type <auth-type> --expected-model <model> --expected-base-url <https-base-url> \
  -- qwen --approval-mode plan --auth-type <auth-type> --model <model> --openai-base-url <https-base-url> -o stream-json -p "$(cat .agent-runtime/<change-id>/artifacts/review-prompt-<id>.md)"
```

Adapter 負責：
1. 啟動 Qwen process 並擷取 stdout。
2. 從 markdown／JSON 輸出中提取 review_result。
3. 驗證 review_result 符合 `agent-result.schema.json`（changeId、runId、stage、kind、producer）。
4. 原子寫入 `.agent-runtime/<change-id>/artifacts/<artifact-id>.json` 與 capture 證據，不覆寫既有結果。
5. 依 verdict 執行 CurrentState transition（phase、owner、gateStatus、handoff、blockers、nextActions）。
6. 原子寫入 `.agent-runtime/<change-id>/current-state.json`。

若直接啟動 Qwen（不經由 adapter），Qwen 的唯讀邊界（`QWEN.md` §13, `openspec/specs/qwen-readonly-result-capture/spec.md`）禁止其寫入 `.agent-runtime/`；Review 完成後，人工必須手動執行 adapter 或手動更新 CurrentState。

CurrentState Transition 規則：

| Verdict | currentPhase | currentOwner | reviewPassed | handoffStatus |
|---------|-------------|-------------|-------------|---------------|
| APPROVE | READY_FOR_READINESS_CHECK | CCR | true | COMPLETED |
| COMMENT_ONLY | READY_FOR_READINESS_CHECK | CCR | true | COMPLETED |
| REQUEST_CHANGES | CHANGES_REQUESTED | Codex | false | COMPLETED |
| INCOMPLETE | INCOMPLETE | CCR | false | FAILED |

Adapter 只接受符合 canonical `current-state.schema.json` 根層 schema 的 current-state.json（必須有 `currentPhase`、`currentOwner`、`gateStatus`、`latestHandoff` 等 required fields）。使用舊 coordinator_result wrapper 形狀的檔案將被拒絕。

## 專案注意事項

- 本文件是本 repo 的專案版 workflow，不是通用開源版。
- 本專案常見邊界是 `frontend` / `bff` / `backend`，但具體仍以 change scope 為準。
- 涉及 resolver / provider / tool / planner 時，必須避免 hard-coded mapping、keyword shortcut、phrase stripping 或特殊案例分支取代正式契約。
- git commit / push 一律由人執行；agent 最多產生 commit message 建議。

## 多調用方與授權容器補充
CCR 與 Codex MUST 只經 adapter 調用 Qwen，使用相同 ADAPTER_LAUNCH_PATTERN。確認 owner 為 Qwen，review-plan phase 為 PLAN_REVIEW，review-result 為 READY_FOR_REVIEW／REVIEWING。須指定唯一 artifact-id、stream-json、expected-auth-type／expected-model／expected-base-url，及對應的 Qwen plan／provider 參數。adapter 或百煉連線失敗不得直接執行 qwen。

adapter 在讀取 CurrentState 前以 wx 取得 review.lock（pid、startedAt、runId、artifactId），finally 釋放；已有 lock 回報 review_lock_held，由人工確認 stale lock。artifact 使用 <artifact-id>.json，不覆寫既有結果。observed.readPaths 只保存遮蔽的相對路徑；read_scope_violation／read_scope_not_proven 使 effective verdict 為 INCOMPLETE。

契約 schema 現位於 openspec/specs/{current-state,handoff,agent-result}-contract/。Master 容器依 authorizationRef 的 ID 取單筆，不得聯集 scope；只有 Master 可執行 GC。self_acceptance inputRefs 保存 authorizationId 與 authorizationSnapshot（相同 ID、normalizedJson、sha256）。
