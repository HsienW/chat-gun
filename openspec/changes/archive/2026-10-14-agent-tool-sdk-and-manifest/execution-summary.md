# Execution Summary

## 實際完成內容與 Design 差異

- `gun-harness` 發布 `@gun-ai/harness-contracts`、`kernel`、`sdk`、`testkit` 的 `0.1.0-alpha.2`；SDK 提供版本化 manifest、宣告與註冊驗證、provider 投影、hooks 與 typed context view，不承擔 tool 執行。
- chat-gun 以受信 adapter 將 `current_weather` manifest 接入既有 registry、X14 dispatch、X13 authorization 與 X25 execution profile；`manifestVersion` 僅作 additive provenance。BFF 與 frontend 的相容性測試涵蓋有無版本欄位及未知欄位。
- T6 的 fixture ownership 依核准修訂實作：`testkit` 與 backend 消費共用 failure fixture，SDK 套件測試保留等價的本套件案例，維持 `testkit → sdk` 單向依賴。其餘實作符合已核准 Design，未新增第二個 executor 或 authorization 路徑。

## 主要修改檔案

- `gun-harness/packages/contracts/`、`packages/sdk/`、`packages/testkit/` 與相關 package metadata、測試、README。
- chat-gun 的 `backend/src/tools/sdk/`、`backend/src/tools/registry.ts`、runtime provenance、architecture checks 與相鄰測試。
- `backend/package.json`、`backend/package-lock.json`、BFF／frontend 相容性測試，以及 `.github/workflows/harness-candidate-integration.yml`、`harness-registry-integration.yml`。
- 本 change 的 proposal、design、tasks 與三份 delta spec 已封存；三份新增能力的主 spec 已同步至 `openspec/specs/`。

## 驗證結果

- OpenSpec 52 項 task 全部勾選；14 項 Requirement、44 個 Scenario 經實作與 Qwen `APPROVE` 審查覆蓋，無 Blocker 或 Major。封存前 `openspec validate agent-tool-sdk-and-manifest --strict` 通過。
- 既有驗證紀錄：`gun-harness` 34 個測試及 build/typecheck 通過；backend 1653 個測試通過、46 個略過，lint/build 通過；BFF 139 個 Vitest 與 10 個 Node 測試及 build 通過；frontend 180 個測試及 lint/build 通過。frontend 保留既有 lint／chunk-size 警告。
- PR #141 的 Windows／Linux published-registry CI [run 38399220692](https://github.com/HsienW/chat-gun/actions/runs/38399220692) 與 fixed-SHA candidate CI [run 38406402323](https://github.com/HsienW/chat-gun/actions/runs/38406402323) 均通過；四套件在 backend manifest 與 lockfile 鎖定 exact registry `0.1.0-alpha.2`。
- 本 archive 階段同步新增三份主 spec，各含 5、5、4 項 Requirement。OpenSpec CLI 對 proposal 缺少 `Why`／`What Changes` 標題給出非阻斷提示；封存仍成功，原 proposal 內容未改寫。
- 未執行：上傳 artifact 的認證下載與內容獨立核對；PostgreSQL、Opik、model/provider live smoke。本 archive 階段未重跑完整套件測試。

## 接受的風險與理由

- Candidate CI 的兩個 artifact 已上傳，且產生與上傳步驟通過；內容未獨立下載核對。Qwen 將此列為 Minor，readiness-check 接受為非阻斷限制。
- Live smoke 未執行；deterministic 測試與跨平台 CI 已通過。Qwen 將此列為 Minor，Human 可在合併前補做。
- Host X26 compatibility tuple 含 backend 版本 `0.1.0`；後續升版時須重新核對跨 repo 相容性。

## 未完成項目

- OpenSpec task 無未完成項。封存變更尚待 Human 檢視並執行 Git commit、push；PR 合併仍由 Human 決定。
- 上述兩項未執行驗證保留為可追蹤限制，不宣稱已通過。

## 重要決策與取捨

- SDK 只提供宣告與驗證；trusted identity、authorization、sandbox、side-effect 與 event 的強制語意繼續由既有 runtime 擁有。
- `current_weather` 以 staging 組裝取代 direct descriptor，保留 legacy／SDK 隔離配對測試與單一 stable ID。
- 發布順序為 Human 發布四個同版套件，再以 exact registry lockfile 與 Windows／Linux CI 驗證 chat-gun；fixed-SHA tarball 證據與正式 registry 證據分開保存。

## Commit 建議

```text
docs(openspec): archive agent tool SDK change

- Promote the manifest, SDK surface, and runtime integration specs.
- Preserve the approved change artifacts and execution summary.
- Record cross-platform validation and remaining live-smoke limits.

OpenSpec Change: agent-tool-sdk-and-manifest
Co-Authored-By: Claude <noreply@anthropic.com>
```
