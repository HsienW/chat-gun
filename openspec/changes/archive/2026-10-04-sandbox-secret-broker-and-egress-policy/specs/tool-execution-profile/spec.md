# tool-execution-profile Specification

## Purpose

本規格定義 versioned execution profile、兩類 execution mode 與 pluggable sandbox runner 的正式需求：在統一 dispatch pipeline 的 authorization 之後、實際執行之前，插入 execution-profile resolution 與 sandbox capability matching；任何 profile 缺失、版本不支援、runner capability 不足的情況一律 fail-closed，不得降級為 host／in-process 執行。

## ADDED Requirements

### Requirement: versioned `ExecutionProfile` schema MUST 以單一型別表達 OS 與資源邊界

Backend MUST 定義單一 versioned `ExecutionProfile`，涵蓋 `profileVersion`、`filesystem`（roots／writeMode）、`process`（creation allow/deny）、`resources`（cpu／memory／disk／wall-clock 上限）、`egress`（destinations／protocols／DNS 行為）、`env`（白名單）、`binaries`（可用 binaries／runtime images）與 `output`（size／artifact handling）。該 schema MUST 以 strict runtime schema（Zod）驗證，未知欄位 fail-closed。

#### Scenario: 完整 profile 通過驗證

GIVEN 一個具備全部欄位且 `profileVersion` 合法的 execution profile
WHEN 以 runtime schema 解析
THEN MUST 通過並回傳 `ExecutionProfile`
AND 每個欄位 MUST 有明確型別與語意

#### Scenario: 未知欄位被拒絕

GIVEN 一個 execution profile 含未知欄位
WHEN 以 strict runtime schema 解析
THEN MUST 被拒絕
AND MUST NOT 靜默忽略後放行

#### Scenario: 不支援的 profileVersion 被拒絕

GIVEN 一個 execution profile 的 `profileVersion` 為目前 runtime 不支援的版本
WHEN 解析該 profile
THEN MUST 回傳 typed compatibility failure
AND MUST NOT 以降級或預設補齊後放行

---

### Requirement: 兩類 execution mode MUST 明確區分，且 `isolated_process` 無 runner 時 MUST deny

執行邊界 MUST 區分 `trusted_in_process`（僅既有、明確註冊的 read-only native tools，仍須 profile）與 `isolated_process`（external-process／MCP／SDK tools）。`isolated_process` 在沒有可執行該 profile 的 runner 時 MUST 為 `unsupported` 並 deny。

#### Scenario: `trusted_in_process` 仍須 profile

GIVEN 一個既有 read-only native tool 未宣告任何 profile
WHEN 執行 dispatch
THEN MUST deny
AND MUST NOT 以「無 profile」表示信任

#### Scenario: `isolated_process` 無 runner deny

GIVEN 一個 external-process／MCP tool 宣告 `isolated_process`
AND 目前沒有可執行該 profile 的 sandbox runner
WHEN 執行 dispatch
THEN MUST deny（`unsupported`）
AND MUST NOT 以 Node `spawn` 假裝隔離
AND MUST NOT 退回 in-process 或 host process 執行

#### Scenario: 有 runner 才執行 `isolated_process`

GIVEN 一個 `isolated_process` tool
AND 存在可執行該 profile 的 sandbox runner
WHEN 執行 dispatch
THEN MUST 經該 runner 執行
AND runner 輸入 MUST 帶 profile 與 invocation 描述

---

### Requirement: `SandboxRunnerPort` MUST 宣告 capability，capability 不足時 MUST deny

Backend MUST 定義 `SandboxRunnerPort`（`capabilities()` 與 `run(invocation, profile)`）。profile 要求超出 runner capability 時 MUST fail-closed，不得以 partial capability 執行。

#### Scenario: capability 不足 deny

GIVEN 一個 execution profile 要求 process creation 隔離
AND runner 的 capability 不包含 process creation 隔離
WHEN capability matching
THEN MUST deny
AND MUST NOT 以「部分匹配」執行

#### Scenario: runner unavailability 為 typed infrastructure failure

GIVEN sandbox runner 啟動失敗或不可用
WHEN 執行需要 runner 的 tool
THEN MUST 回傳 typed infrastructure failure
AND privileged tool MUST fail closed
AND MUST NOT 降級為 unsandboxed 執行

---

### Requirement: enforcement seam MUST 依固定順序插入，且三條 dispatch 路徑 MUST 共用

execution-profile resolution 與 capability matching MUST 發生在 authorization 之後、實際 tool 執行之前，順序固定為 `authorization → execution-profile resolution → sandbox capability matching → execution`。`GovernanceExecutor.executeInternal`、graph-level `physicalDispatch`、pipeline `dispatch()` 三條路徑 MUST 共用同一 enforcement 原語，不得分流。

#### Scenario: 順序固定

GIVEN 一個受保護 tool 進入 dispatch
WHEN 觀察 enforcement 順序
THEN authorization MUST 先於 profile resolution
AND profile resolution MUST 先於 execution
AND 任一前置步驟 fail MUST 停止後續執行

#### Scenario: 三路徑共用

GIVEN 同一 tool 經 governance、graph-level、pipeline 任一進入點 dispatch
WHEN 執行 enforcement
THEN 三路徑 MUST 套用同一 profile resolution 與 capability matching
AND MUST NOT 存在分流或 per-path 獨立的 sandbox 判斷

#### Scenario: profile 缺失 deny

GIVEN 一個 tool 未解析到任何 execution profile
WHEN dispatch
THEN MUST 於執行前 deny
AND MUST NOT 回退 host execution

---

### Requirement: audit evidence MUST 記錄 profile 版本、effective capabilities 與 termination cause

每次 tool 執行 MUST 在 side-effect／audit evidence 記錄 `executionProfileVersion`、effective capabilities 與 termination cause，且可對應 run／task／step／principal／tool-call identity。

#### Scenario: evidence 可對應 identity

GIVEN 一次 tool 執行完成
WHEN 查詢其 audit evidence
THEN MUST 含 `executionProfileVersion` 與 effective capabilities
AND MUST 含 termination cause
AND MUST 可對應 run／task／step／principal／tool-call identity

#### Scenario: profile 缺失或 deny 亦留 evidence

GIVEN 一次 tool 執行因 profile 缺失或 capability 不足被 deny
WHEN 查詢其 audit evidence
THEN MUST 記錄 deny 的 termination cause 與決策
AND MUST NOT 無痕跡地靜默 deny

---

### Requirement: MCP 與未來 SDK tools MUST 走與 built-in tools 相同的 enforcement 路徑

MCP servers 與未來 SDK tools 的執行 MUST 通過與 built-in tools 相同的 execution-profile resolution 與 capability matching，不得存在獨立繞過路徑。

#### Scenario: MCP 走同一 enforcement

GIVEN 一個 MCP tool 進入 dispatch
WHEN 執行 enforcement
THEN MUST 走與 built-in tools 相同的 profile resolution 與 capability matching
AND MUST NOT 以 stdio subprocess 直接執行而跳過 enforcement

#### Scenario: 未來 SDK tool 不得跳過

GIVEN 未來新增 SDK tool
WHEN 進入 runtime dispatch
THEN MUST 通過同一 enforcement 路徑
AND MUST NOT 存在未經 profile resolution 的 dispatch 分歧
