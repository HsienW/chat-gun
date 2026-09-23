# Execution Summary

## 實際完成內容與 Design 差異

- 建立 production `RuntimeToolDescriptor`、單一 registry 與統一 dispatch pipeline。
- read-only Tool 經 typed executor；mutation Tool 經 `ToolExecutionRunner`、durable ledger、result reference、reconcile-first 與受限 retry。
- 新增 versioned structured tool result、bounded scheduler、Task/Step adapter、audit／metric／trace isolation 與 compensation seam。
- Math、Deep Research 與 MCP dispatch 以預設關閉的 per-source feature flags 接入，不改變既有 Graph ID、BFF route 或預設 runtime 行為。
- MCP protocol 缺少通用 mutation status query，因此 ambiguous mutation 保守回傳 `unknown` 並 park；未宣稱完成 provider-specific live reconciliation。

## 主要修改檔案

- `backend/src/runtime/tool-dispatch/`：descriptor、scheduler、structured result、Task/Step adapter、pipeline 與 tests。
- `backend/src/runtime/side-effect/tool-execution-runner.ts`：effect truth persistence、retry category gate、observability isolation。
- `backend/src/tools/production-runtime-tool-descriptors.ts`：local 與 MCP production descriptors。
- `backend/src/tools/registry.ts`、`backend/src/tools/mcp-loader.ts`：production composition 與 pipeline injection。
- `backend/src/agents/math-agent.ts`、`backend/src/platform/tool-governance.ts`：agent routing 與 governed executor seam。
- `backend/.env.example`：三個 default-off rollout flags。

## 驗證結果

- `npm run lint`：通過。
- `RUN_OPIK_EVALUATION=false npm run test`：153 個 test files、1061 個 tests 通過；6 個 test files、46 個 tests skip。
- `npm run build`：通過。
- Scoped `git diff --check`：通過。
- `openspec validate establish-unified-tool-dispatch-pipeline --strict`：通過。
- 33/33 OpenSpec tasks 完成。

## 接受的風險與理由

- 正式部署 Agent Server 的 durable restart／replay／reconciliation 尚未 live 驗證；已有 deterministic integration coverage，rollout flags 預設關閉。
- Hosted Opik live evaluation 因受限環境無法連線；deterministic suite 已獨立通過。
- MCP mutation 未具 provider-specific status query 時採 fail-closed parking，禁止 blind retry。

## 未完成項目

- 由 Human 執行 archive commit 與 `git push`。
- 在具備授權的環境執行 Agent Server、MCP mutation reconciliation 與 hosted Opik live smoke tests。
- `tools/qwen-capture-adapter.mjs` 為 scope 外的既有工作區修改，不得納入本 Change archive commit。

## 重要決策與取捨

- Main spec 由唯一 delta spec 完整同步：`Specification Delta` 轉為 `Specification`，`ADDED Requirements` 轉為 `Requirements`，需求與 scenarios 原樣保留。
- 所有 rollout flags 維持 default-off，以單一 source flag 提供回滾能力。
- Archive 只 stage main spec 與日期化 Change rename，不執行 commit 或 push。

## Commit 建議

```text
docs(openspec): archive unified tool dispatch pipeline

- Sync the unified dispatch requirements into the main specification
- Preserve implementation, review, and validation evidence in the archive
- Record remaining live validation gaps and human follow-up actions
```

Implementation commits prepared earlier:

- `ca22653 feat(tool-dispatch): define runtime dispatch primitives`
- `694ecad feat(tool-dispatch): compose governed execution pipeline`
- `0bf4ae4 feat(tools): register production dispatch descriptors`
- `f4a8649 feat(agents): adopt unified tool dispatch routing`
