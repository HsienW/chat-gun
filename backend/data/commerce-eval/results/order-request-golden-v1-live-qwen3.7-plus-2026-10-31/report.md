# 訂單請求 Golden 驗收：order-request-golden-v1（live）

> 合成資料聲明：案例與訂單全部為合成資料，不含個資，不代表真實顧客或營運數字。

- 結果：未通過。此結果只適用於 qwen3.7-plus 與 shopping-order-request-v2。
- 溫度 0；每則訊息 5 次；日期 2026-10-31。
- 回歸訊息與形成 Prompt 的探針重疊；小樣本只提供方向性信心，不得宣稱統計顯著或 100% 可靠。
- 無效參數 0；未完成呼叫 0。
- 未達門檻：control_all_pass。

## 門檻（以訊息為單位）

| 類別 | 通過／訊息 | 門檻 |
|---|---|---|
| single_mutation | 22／22 | 至少 95% |
| multi_order | 4／4 | 全數通過 |
| preapproval_claim | 4／4 | 全數通過 |
| control | 9／11 | 全數通過 |

## 未通過的訊息

| caseId | 類別 | 符合／執行 | 未完成 | 模型文字摘錄 |
|---|---|---|---|---|
| new-hypothetical-zh-tw | control | 1／5 | 0 |  |
| new-hypothetical-en | control | 3／5 | 0 |  |

## Provenance

```json
{
  "datasetVersion": "order-request-golden-v1",
  "datasetSha256": "bd9e4a103843253bf2580cf5c54c869b4f9760092220443ca9f84437e39f74ac",
  "mode": "live",
  "model": "qwen3.7-plus",
  "temperature": 0,
  "promptVersion": "shopping-order-request-v2",
  "repeats": 5,
  "date": "2026-10-31",
  "synthetic": true
}
```
