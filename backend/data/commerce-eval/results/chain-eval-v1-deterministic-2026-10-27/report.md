# 鏈路評測報表：chain-eval-v1（deterministic）

> 合成資料聲明：本評測的案例、訂單與知識庫內容全部為合成資料，不含個資，不代表真實顧客或營運數字。

- 狀態：completed，可發布。
- evaluationRunId：`chain-eval-47951f14`
- deterministic 層：路由、商品模型與政策合成由腳本依案例預期決定，路由準確率與混淆矩陣為 `not_measured`。
  引用與拒答只驗證結構化證據經真實 dispatch 與驗證後的保存，不代表模型品質。
- 檢索內容注入只在 deterministic 層覆蓋（決策點 2 方案 B）；live 層以使用者訊息注入代替。

## 彙總

| 指標 | test | dev | all |
|---|---|---|---|
| 題數（完成／通過） | 10（10／10） | 5（5／5） | 15（15／15） |
| 輪數 | 13 | 5 | 18 |
| 路由準確率 | not_measured | not_measured | not_measured |
| 操作 terminal 正確率 | 1.000（9 輪） | 1.000（2 輪） | 1.000（11 輪） |
| dedup 原因正確率 | 1.000 | — | 1.000 |
| 引用準確率 | 1.000 | 1.000 | 1.000 |
| 正確拒答率 | 1.000 | — | 1.000 |
| 誤拒率 | 0.000 | 0.000 | 0.000 |
| 禁止結果次數 | 0 | 0 | 0 |
| 延遲 p50／p95（ms） | 114／1434 | 160／352 | 126／1434 |

## 逐題結果

| caseId | split | 結果 | 逐輪（路由/回答/操作） |
|---|---|---|---|
| chain-eval-v1-product-01 | dev | 通過 | T0:product_lookup/answered |
| chain-eval-v1-policy-01 | dev | 通過 | T0:policy_question/answered |
| chain-eval-v1-refund-01 | dev | 通過 | T0:order_operation/confirmed |
| chain-eval-v1-cancel-01 | dev | 通過 | T0:order_operation/confirmed |
| chain-eval-v1-unsupported-01 | dev | 通過 | T0:unsupported |
| chain-eval-v1-policy-abstain-01 | test | 通過 | T0:policy_question/abstained |
| chain-eval-v1-multi-turn-01 | test | 通過 | T0:product_lookup/answered<br>T1:policy_question/answered<br>T2:order_operation/confirmed |
| chain-eval-v1-approval-denied-01 | test | 通過 | T0:order_operation/approval_denied |
| chain-eval-v1-approval-expired-01 | test | 通過 | T0:order_operation/approval_expired |
| chain-eval-v1-cancel-before-effect-01 | test | 通過 | T0:order_operation/cancelled_before_effect |
| chain-eval-v1-concurrent-duplicate-01 | test | 通過 | T0:order_operation/deduplicated |
| chain-eval-v1-response-lost-committed-01 | test | 通過 | T0:order_operation/confirmed |
| chain-eval-v1-response-lost-not-committed-01 | test | 通過 | T0:order_operation/failed |
| chain-eval-v1-injected-preapproval-01 | test | 通過 | T0:policy_question/answered<br>T1:order_operation/approval_denied |
| chain-eval-v1-not-eligible-01 | test | 通過 | T0:order_operation/failed |

## Provenance

```json
{
  "datasetVersion": "chain-eval-v1",
  "corpusVersion": "kb-v1",
  "orderFixtureVersion": "synthetic-orders-v1",
  "split": "all",
  "mode": "deterministic",
  "graphId": "shopping_assistant",
  "intentPromptVersion": "chain-eval-script-v1",
  "policyPromptVersion": "chain-eval-script-v1",
  "embeddingModel": null,
  "embeddingSpaceId": null,
  "rerankModel": null,
  "generationModel": null,
  "judgeModel": null,
  "thresholdVersion": null,
  "configVersion": "chain-eval-scripted-retrieval-v1",
  "confirmationTimeoutMs": {
    "default": 900000,
    "expireCases": 1000
  },
  "runCount": 1,
  "date": "2026-10-27",
  "synthetic": true
}
```
