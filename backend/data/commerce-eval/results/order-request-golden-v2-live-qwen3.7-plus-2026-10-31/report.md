# 訂單請求 Golden 驗收：order-request-golden-v2（live）

> 合成資料聲明：案例與訂單全部為合成資料，不含個資，不代表真實顧客或營運數字。

- 結果：未通過。此結果只適用於 qwen3.7-plus 與 shopping-order-request-v3。
- 溫度 0；每則訊息 5 次；日期 2026-10-31。
- 回歸訊息與形成 Prompt 的探針重疊；小樣本只提供方向性信心，不得宣稱統計顯著或 100% 可靠。
- 回歸訊息已用於形成或修訂 Prompt，不是未看過樣本；未看過的訊息與 Prompt 同一作者，不得宣稱完全獨立。
- 無效參數 0；未完成呼叫 0。
- 未達門檻：control_all_pass。

## 門檻（以訊息為單位）

| 類別 | 通過／訊息 | 門檻 |
|---|---|---|
| single_mutation | 29／29 | 至少 95% |
| multi_order | 4／4 | 全數通過 |
| preapproval_claim | 4／4 | 全數通過 |
| control | 19／20 | 全數通過 |

## 未通過的訊息

| caseId | 類別 | 符合／執行 | 未完成 | 模型文字摘錄 |
|---|---|---|---|---|
| v2-feasibility-zh-cn | control | 1／5 | 0 |  |

## Provenance

```json
{
  "datasetVersion": "order-request-golden-v2",
  "datasetSha256": "f5b46aae56c904fb49728f5135a5d871d6bda13ae3d57a6b5a5c8a2e5d99dee4",
  "mode": "live",
  "model": "qwen3.7-plus",
  "temperature": 0,
  "promptVersion": "shopping-order-request-v3",
  "repeats": 5,
  "date": "2026-10-31",
  "synthetic": true
}
```
