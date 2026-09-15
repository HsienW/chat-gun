# Runtime Operations SLO／SLI

## Policy contract

Runtime SLO 使用外部注入、版本化的 **slo-policy/v1** 設定文件。Production threshold 與 evaluation window 不得寫入 business logic；release gate、dashboard 與 alert rule 必須引用同一份已核准 policy artifact。

範例欄位：

    {
      "schemaVersion": "slo-policy/v1",
      "policyVersion": "<deployment-owned-version>",
      "thresholds": {
        "<threshold-key>": "<finite deployment-owned value>"
      },
      "windows": {
        "<window-key>": "<deployment-owned duration>"
      }
    }

部署系統以 **OPERATIONS_SLO_POLICY_PATH** 指向 policy artifact，並在啟動或 release gate 執行前完成 Schema 驗證。檔案不存在、版本未知、數值非 finite，或必要 key 缺失時必須 fail closed；不得退回程式碼內建的 production 預設值。

## SLO／SLI matrix

| Dimension | SLI | OpenMetrics source | Objective direction | Threshold config key | Window config key |
| --- | --- | --- | --- | --- | --- |
| Task reliability | Task Success Rate | chat_gun_task_total{outcome} | minimum | task_success_rate_min | task_reliability_window |
| Recovery | Resume Success Rate | chat_gun_recovery_total{decision,outcome} | minimum | resume_success_rate_min | recovery_window |
| Recovery | Retry Recovery Rate | chat_gun_retry_total{outcome} | minimum | retry_recovery_rate_min | recovery_window |
| Side-effect safety | Duplicate Prevention Rate | chat_gun_side_effect_reconciliation_total{outcome} | minimum | duplicate_prevention_rate_min | side_effect_window |
| Side-effect safety | Unknown Effect Rate | chat_gun_side_effect_reconciliation_total{outcome} | maximum | unknown_effect_rate_max | side_effect_window |
| Compensation | Compensation Success Rate | chat_gun_compensation_total{outcome} | minimum | compensation_success_rate_min | compensation_window |
| Latency | Task Completion P95 | Task duration histogram supplied by the OTel collector | maximum | task_completion_p95_ms_max | latency_window |
| Latency | Tool P95 | Tool duration histogram supplied by the OTel collector | maximum | tool_p95_ms_max | latency_window |
| Queue | Queue Wait P95 | Queue wait histogram supplied by the native runtime projection | maximum | queue_wait_p95_ms_max | queue_window |
| Worker | Saturation | chat_gun_worker_saturation_ratio | maximum | worker_saturation_max | worker_window |
| Worker | Stuck-run count | chat_gun_stuck_run_count | maximum | stuck_run_count_max | worker_window |
| Worker | Heartbeat freshness | chat_gun_worker_heartbeat_freshness_ms | maximum | heartbeat_freshness_ms_max | worker_window |
| Model | Fallback Rate | Model route events aggregated by the OTel collector | maximum | model_fallback_rate_max | model_window |
| Model | Repair Success Rate | Structured-output repair events aggregated by the OTel collector | minimum | model_repair_success_rate_min | model_window |
| Cost | Cost per Successful Task | chat_gun_cost_total divided by successful tasks; policy currency must match the X8 collector currency | maximum | cost_per_successful_task_usd_max | cost_window |
| Recommendation quality | Hard Negative Leakage | Version-pinned X8.5A evaluation report | maximum | hard_negative_leakage_max | evaluation_window |
| Recommendation quality | Constraint Violation | Version-pinned X8.5A evaluation report | maximum | constraint_violation_rate_max | evaluation_window |

缺少 native queue、capacity 或 heartbeat signal 時，health projection 必須輸出 degraded／missing signal；不得以零值冒充健康。沒有適用資料的 SLI 應標為 **not_applicable**，不得當作通過。

## Export and aggregation

- Backend 透過唯讀 **GET /operations/metrics** 提供 OpenMetrics/Prometheus-compatible pull exposition。
- BFF 僅透過受 identity／authorization 保護的 **GET /api/operations/metrics** 轉發；禁止 query、request body、credential forwarding 與未授權讀取。
- Scraper／OTel collector 負責跨 process 聚合、histogram 與 derived-rate 計算；application 不建立第二套聚合器或 worker registry。
- Label 僅可使用固定、低基數且已彙總的 operation/status/outcome。tenant、principal、Task、Run、ToolCall ID，以及 raw prompt、credential、PII、tool output 均不得輸出。
- 既有 **GET /api/metrics** JSON snapshot 維持相容，不作為本 policy 的 scrape contract。

## Change control

Policy artifact 必須和 release candidate 一起保存 schemaVersion、policyVersion 與 checksum。調整 threshold 時只更新並審核 policy artifact；不修改 business logic。未知 policy version、缺少 requirement 所需 SLI，或報表與 policy checksum 不一致時，release gate 必須拒絕發布。
