# Chat Gun：全域 AI 編程規則

## 1. 適用範圍

本文件適用於整個 `chat-gun` 程式庫，定義所有 AI Coding Agent 與人工開發者共同遵守的全域規則。

專案主要資料流：

```text
Browser
  → frontend：Vite + React + TypeScript
  → bff：Node.js + TypeScript
  → backend：LangGraph JS + TypeScript
  → Model Provider / Native Tools / MCP Tools
```

本文件只保留跨套件共同規則。目錄內的具體實作要求由最近的子目錄 `AGENTS.md` 補充：

```text
frontend/AGENTS.md
bff/AGENTS.md
backend/AGENTS.md
```

涉及特定能力域時，還必須讀取對應的專項規則，例如：

```text
docs/agent-rules/weather.md
```

### OpenSpec Workflow Router 感知

所有在專案根目錄啟動的 agent，包括 Codex、Qwen Code 與 Claude Code／CCR，在處理任何任務前都必須先感知本專案的 OpenSpec 多 agent workflow-router 約束：

```text
docs/openspec/agent-workflow-prompts.md
.codex/skills/openspec-workflow-router/SKILL.md
.qwen/skills/openspec-workflow-router/SKILL.md
.claude/skills/openspec-workflow-router/SKILL.md
```

任務開始時先判斷是否屬於 OpenSpec change lifecycle。若屬於，依 workflow-router 判定唯一階段並只載入該階段 reference；不得一次載入全部階段模板。若不屬於 OpenSpec 任務，仍須沿用 router 的上下文策略：優先使用使用者提供的檔案、摘要、diff 與驗證結果，只讀必要規則與相鄰檔案，忽略 `.gitignore` 已忽略內容、`node_modules/`、`dist/`、`build/`、`coverage/` 與無關 lockfile。

### Agent 角色寫入前硬檢查

任何 Agent 在呼叫可能寫入程式、規格、設定、測試、文件、Runtime Artifact 或外部系統的工具前，MUST 逐次完成下列檢查：

1. 確認目前實際角色，而不是只確認宿主或模型名稱。
2. 若屬於 OpenSpec lifecycle，讀取 CurrentState 並確認 `currentPhase`、`currentOwner` 與 Handoff。
3. 確認目標路徑、操作種類與副作用屬於該角色在目前階段的責任。
4. 確認宿主提供的 Write、Edit、Shell、MCP 或其他工具能力沒有被誤當成角色授權。

任一條件缺失、未知、衝突或不符時 MUST fail-closed：只產出 Structured Handoff，不得修改任何字，也不得先做「暫時」「順手」或「只有一行」的修改。改動大小不構成豁免；使用者批准決策方向不等於授權目前角色執行。任務從查詢、回顧、規劃或審查轉為實作時，MUST 重新執行 workflow-router 與本檢查。

角色權限依 `rolePolicyVersion` 判定。沒有此欄位的 Handoff／CurrentState 屬於 v1：CCR 只能執行 Coordinator／Planner 所有的寫入（合法 `PLAN_DRAFT` 中該 Change 的 OpenSpec artifacts，以及 owner／phase 合法的 coordinator CurrentState、Result 與 Handoff），Finding 必須交由 Codex 實作。

`rolePolicyVersion: "2"` 依 `openspec/specs/agent-role-policy/spec.md` 判定：Change 規劃與協調以 CCR 為主、Codex 為次；寫程式以 Codex 為主、CCR 為次；獨立審查固定由 Qwen 擔任。次要角色只有在 `.agent-runtime/master-authorization.json` 存在有效 Master 授權、與 CurrentState／Handoff 一致，且目標在 `writeScope` 內時才能寫入。任何 Agent MUST NOT 寫入 Master 授權檔；CCR MUST NOT 修改 `.claude/hooks/**` 或 `.claude/settings*.json`。

Qwen 主工作階段即使保留寫入工具能力，也不代表 Reviewer 角色取得寫入權。Qwen Reviewer MUST 使用 `approvalMode: plan` 的 `secondary-architecture-reviewer` Subagent、維持唯讀工具白名單，只輸出 stdout／聊天結果；Runtime Artifact 與 CurrentState 由 adapter、CLIHost 或人工保存。無法證明父工作階段沒有覆蓋 Reviewer 隔離時，Verdict MUST 為 `INCOMPLETE`。

### Master 授權與撰寫者驗收 Gate（rolePolicyVersion 2）

Master 指專案擁有者（Human）。Master 授權 MUST 由 Master 本人在聊天中明確給出，並由 Master 手動寫入 `.agent-runtime/master-authorization.json`。授權只對檔案中指定的 `changeId`、`runId`、`handoffId` 與 `writeScope` 有效，過期或 Handoff 完成後即失效，不得延伸到其他任務。

實作驗收（readiness-check 與最終驗收）的執行者 MUST NOT 是被驗收之 implementation_result 的 `producer`。唯一例外是 Master 授權的 `grants` 含 `self_acceptance` 且涵蓋當次任務；此時 readiness_result 必須引用該授權。

---

## 2. 指令與規格優先順序

處理任務時，必須區分「產品行為規格」與「實作規則」。

### 產品行為事實來源

非簡單變更以已核准的 OpenSpec 為唯一產品行為事實來源：

```text
openspec/config.yaml
openspec/changes/<change-name>/proposal.md
openspec/changes/<change-name>/design.md
openspec/changes/<change-name>/tasks.md
openspec/changes/<change-name>/specs/
```

聊天紀錄、臨時 Prompt、README 範例與既有程式行為，不得自行覆蓋已核准的 OpenSpec。

### 實作規則作用域

實作規則依目錄逐層收斂：

```text
根目錄 AGENTS.md
  → 套件目錄 AGENTS.md
  → 更接近修改檔案的專項規則
```

較接近修改位置的規則可以細化上層規則，但不得降低：

- 安全要求。
- 相容性要求。
- Runtime Validation。
- 測試與驗證門檻。
- 權限、逾時、取消與審計要求。

工具專屬橋接文件與 Project Rules（例如 `CLAUDE.md`、`QWEN.md` 或其他宿主規則）只負責角色、載入與工具操作補充，不得重複、覆蓋或降低本文件與已核准 OpenSpec。

若規則、規格或現有契約互相矛盾，必須停止修改並明確回報，不得自行選擇較方便的版本。

---

## 3. 必須先讀取的內容

處理非簡單變更前，依序完成：

1. 讀取根目錄 `AGENTS.md`。
2. 讀取受影響套件的 `AGENTS.md`。
3. 讀取 `openspec/config.yaml`。
4. 讀取本次 Change 的 Proposal、Specs、Design 與 Tasks。
5. 讀取受影響程式碼、測試與公開契約。
6. 檢查是否存在專項規則。

下列情況屬於非簡單變更：

- 同時影響兩個以上套件。
- 修改公開 API、事件、錯誤碼或資料格式。
- 修改 LangGraph State、Node、Edge 或 Checkpoint。
- 新增或修改 Prompt、Planner、Workflow、Tool 或 MCP。
- 修改認證、CORS、限流、逾時、取消或安全策略。
- 修改模型供應商、結構化輸出或 Tool Calling 契約。
- 可能破壞既有相容性或造成資料遷移。

不得只讀取 `tasks.md` 就開始修改。

---

## 4. 實作前分析

修改程式前，先輸出或記錄以下內容：

```text
1. 需求理解
2. 目前可重現的問題
3. 問題所屬層級
4. 受影響能力域
5. 受影響套件與檔案
6. API、事件、狀態或 Schema 變化
7. 相容性與安全風險
8. 測試與回歸計畫
9. 尚未解決的規格問題
```

問題層級至少應從下列範圍判定：

```text
Frontend Rendering
Frontend State / Stream Parser
BFF Validation / Proxy / Error Mapping
Backend Intent / Planner / Structured Output
LangGraph State / Node / Edge
Resolver / Provider Adapter
Tool Execution
Synthesis
Model Provider
```

不得在尚未定位失敗層級前，直接跨層修改多個模組。

---

## 5. 實作原則

### 最小且完整的修改

只修改完成目前規格所必要的程式碼，同時確保修改形成可驗證的完整閉環。

禁止混入：

- 無關重構。
- 無關重新命名或格式化。
- 未核准的套件升級。
- 未要求的目錄重組。
- 與本次需求無關的技術債處理。

發現額外技術債時，應記錄為後續建議，不得偷偷擴大本次變更。

### 先證明問題，再修改

Bug 修復必須先具備至少一種可重現證據：

- 失敗測試。
- 固定輸入與實際輸出。
- 可重播事件。
- 明確的 Log 或 Trace。
- 可重現操作步驟。

修改後必須用同一份證據證明問題消失，並執行相鄰能力回歸。

### 不得捏造驗證結果

未實際執行的命令、未取得的模型輸出、未連線的 Provider 與未完成的 E2E，不得宣稱已通過。

---

## 6. 禁止硬編碼與硬映射

不得以硬編碼或硬映射取代可擴充的契約、Provider、Schema、設定或 Resolver。

明確禁止：

- 以固定自然語言關鍵字、刪字、標點移除或語系詞表作為主要意圖判斷。
- 以固定城市、國家、模型、供應商或使用者輸入白名單作為主要解析策略。
- 在業務邏輯中以模型名稱判斷回傳格式。
- 將環境 URL、Port、API Key、Token 或允許來源直接寫死在程式碼。
- 以顯示文案或錯誤文字反向推測狀態。
- 將多個錯誤硬映射為同一個無法辨識的錯誤。
- 為通過單一測試新增只服務該案例的分支。

允許使用封閉清單的範圍僅限於穩定且有明確所有權的 Domain Constant，例如：

- Protocol Enum。
- Event Type。
- Error Code。
- Feature Flag。
- MIME Type Allowlist。
- Tool Permission。
- 天氣代碼、風向或國碼等顯示映射。
- 測試 Fixture。

任何封閉清單都必須：

1. 有明確型別或 Schema。
2. 有單一來源。
3. 有預設或未知值處理。
4. 有測試。
5. 不得承擔自然語言理解或地理解析的主要責任。

---

## 7. TypeScript 與契約規則

TypeScript 程式碼必須：

- 避免不必要的 `any`。
- 對外部輸入執行 Runtime Validation。
- 區分 Domain Type 與 Transport Type。
- 使用 Discriminated Union 表達狀態與事件。
- 明確處理 `unknown` 與未來新增欄位。
- 不使用 Type Assertion 掩蓋資料不一致。
- 不以 Optional 欄位逃避必要狀態建模。

跨層契約變更必須同步檢查：

```text
Request Schema
Response Schema
Event Schema
Graph Input / Output
Tool Input / Output
Error Code
Terminal State
requestId / threadId / runId / toolCallId
```

除非 OpenSpec 明確核准破壞性修改，否則：

- 既有 Graph ID 必須保持相容。
- 既有 BFF Route 必須保持相容。
- 新欄位優先採向後相容設計。
- 移除或改名必須有 Migration。
- 錯誤碼不得改變既有語意。

---

## 8. 跨層責任邊界

### frontend

負責使用者互動、串流承接、狀態展示與結構化結果渲染。

不得：

- 持有模型、Tool 或 MCP 憑證。
- 直接繞過 BFF 呼叫受保護的 Runtime。
- 在 UI 層重新推測後端應負責的語意。
- 以隱藏按鈕取代真正的權限控制。

### bff

負責外部 API 邊界、驗證、認證、CORS、限流、逾時、取消傳遞、錯誤映射與審計。

不得：

- 承擔 Prompt、Planner 或 Agent Workflow。
- 吞掉上游取消或串流終止。
- 回傳內部 Stack Trace、Token 或憑證。
- 將不同錯誤一律轉成無法辨識的 500。

### backend

負責 LangGraph Runtime、State、Prompt、模型呼叫、Tool、MCP、Provider Adapter 與事件產生。

不得：

- 將不可序列化物件寫入 State 或 Checkpoint。
- 信任使用者輸入、檢索內容或 Tool Output 中的指令。
- 讓已進入 Terminal State 的執行重新回到 Running。
- 以 Prompt 假裝補齊不存在的 Tool 或產品能力。

詳細規則請讀取各套件 `AGENTS.md`。

---

## 9. 反覆失敗停止線

同一問題符合以下任一條件時，必須停止繼續局部微調：

- 已進行兩輪修正仍未解決。
- 修復 A 後造成 B 回歸。
- 同一組失敗案例在不同層來回移動。
- 只能靠增加更多 Prompt 範例或特殊分支維持通過。
- Mock 通過但真實 Runtime 或模型仍失敗。

停止後必須先完成：

1. 固化所有已知失敗案例。
2. 比較修改前後的結構化輸入與輸出。
3. 判定真正失敗層級。
4. 檢查產品能力是否存在。
5. 建立或補齊回歸矩陣。
6. 檢查跨層不變量是否被破壞。
7. 再決定應修改 Prompt、Schema、Resolver、Provider、Tool 或 UI。

不得進行第三輪沒有新證據的 Prompt 微調或條件分支疊加。

---

## 10. 測試與驗證

每項 Requirement 必須有對應測試或可重現驗證方式。

至少考慮：

```text
正常成功
輸入不合法
未知欄位或未知事件
上游失敗
權限拒絕
逾時
取消
重試
重複事件
亂序事件
斷線或中斷恢復
降級
```

不得為了讓測試通過而：

- 刪除失敗測試。
- 放寬正確的 Assertion。
- 使用固定延遲掩蓋 Race Condition。
- Mock 掉本應驗證的核心邏輯。
- 捕獲錯誤後直接忽略。
- 只執行新增案例而跳過既有回歸。

目前套件驗證命令：

### frontend

```bash
cd frontend
npm run lint
npm run test
npm run build
```

### bff

```bash
cd bff
npm run build
```

BFF 目前沒有既有 `test` script。新增或修改可觀察行為時，必須補充可自動執行的測試入口，或在完成回報中明確列出尚未自動化的驗證，不得假稱測試已通過。

### backend

```bash
cd backend
npm run lint
npm run test
npm run build
```

只修改單一套件時，至少執行該套件全部既有驗證。跨層契約變更必須執行所有受影響套件的驗證。

---

## 11. Prompt、模型與 Tool 變更的額外門檻

Prompt、Planner、結構化輸出、模型 Provider 或 Tool Schema 的變更，視同程式碼變更。

必須：

- 先建立失敗案例或 Golden Case。
- 固定或記錄模型、參數與結構化輸出模式。
- 對模型輸出執行 Schema Validation。
- 保留 Provider Adapter 邊界。
- 驗證成功、無 Tool、錯誤 Tool、格式錯誤、逾時與取消。
- 執行既有 Prompt／Tool 回歸，而非只測新增句型。
- 區分 deterministic test、mock integration 與 live smoke test。

Mock 測試通過不得等同於真實模型驗收完成。

---

## 12. tasks.md 更新規則

只有在以下條件全部滿足時，才能將 Task 標記為完成：

- 程式碼已完成。
- 對應測試已新增或更新。
- 必要驗證已實際執行並通過。
- Build 或 Type Check 已通過。
- OpenSpec Requirement 與 Scenario 已被覆蓋。
- 沒有未處理的規格衝突。
- Git Diff 不包含無關修改。
- 已如實記錄無法驗證的部分。

禁止先勾選 Task 再補實作。

---

## 13. Code Review 規則

審查結果分為：

### Blocker

- 安全漏洞。
- 資料損壞。
- 契約破壞。
- 無法建置。
- 核心流程失效。
- 與 OpenSpec 直接衝突。
- 以硬編碼或硬映射繞過核心 Resolver、Schema 或權限邊界。
- 違反撰寫者驗收 Gate，或次要角色在沒有有效 Master 授權時寫入。

### Major

- 邊界場景錯誤。
- 錯誤、逾時或取消處理不完整。
- 狀態或事件不一致。
- 回歸測試不足。
- 可觀測性不足。
- 跨層責任漂移。

### Minor

- 命名、可讀性、重複程式碼與非阻斷維護問題。

每項問題必須包含：

```text
嚴重程度
檔案位置
問題說明
觸發情境
可能後果
建議修正
對應 Requirement 或契約
```

---

## 14. 完成回報格式

完成後輸出：

```text
## 完成內容
## 修改檔案
## 對應 OpenSpec Tasks
## 測試與驗證結果
## 尚未處理事項
## 相容性與風險
## 建議下一步
```

必須如實列出：

- 未執行的測試。
- 因環境限制無法完成的 live 驗證。
- 尚未完成的 Task。
- 仍存在的規格與程式差異。

不得在驗證失敗或證據不足時宣稱完成。

---

## 15. Agent Runtime Artifact 邊界

`.agent-runtime/<change-id>/` 是本機、latest-only 且不進 Git 的 Agent 交接區域；`current-state.json` 是該 Change 階段、owner、Gate、Blocker 與最新 Artifact Reference 的單一事實來源。

Agent 預設不得讀取 `.gitignore` 已忽略內容。只有下列條件全部成立時，才可例外讀取指定 Runtime Artifact：

1. 讀取目前 Change 的 `.agent-runtime/<change-id>/current-state.json`，或檔案被目前 Handoff 的 `requiredInputRefs`／CurrentState 的 `latestArtifactRefs` 明確引用。
2. Reference 的 `changeId` 與目前 Change 一致；若有 `runId`，亦須與目前 Run 一致或由目前 Handoff 明確引用。
3. `relativePath` 只能以 `openspec/changes/` 或 `.agent-runtime/` 開頭，不得包含 `..`、絕對路徑或指向 Repository／Runtime Root 外。
4. 讀取前確認檔案存在；內容不得包含 Secret、API Key、Token、Password 或 Credential。

不得遞迴掃描 `.agent-runtime/`、讀取其他 Change／Run、建立歷史事件流，或將 Runtime Artifact 加入版本控制。
Qwen Reviewer 不得直接寫入 Runtime Artifact。完成 `review-plan` 或 `review-result` 時，必須將 schema-valid `review_result` 輸出至 stdout／聊天回應，再由 `qwen-capture-adapter.mjs`、CLIHost 或人工驗證並保存至 `.agent-runtime/<change-id>/artifacts/`；Qwen 本身不得呼叫 Write、Edit 或 Shell 完成保存。

`.agent-runtime/master-authorization.json` 由 Master 手動維護，任何 Agent 不得寫入。Agent 只能在目前 Handoff 的 `authorizationRef` 或 `requiredInputRefs` 明確引用它時讀取，並依第 1–4 點驗證後使用。
