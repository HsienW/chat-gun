# health-readiness-slo Specification

## Purpose
TBD - created by archiving change high-availability-backup-and-disaster-recovery. Update Purpose after archive.
## Requirements
### Requirement: 五層 health/readiness 語意明確區分

health/readiness endpoint MUST 明確區分 `alive`（process 存活）、`reachable`（dependency 可達）、`accept new work`（可安全承接新工作）、`resume durable work`（可 resume durable work）、`degraded`（唯讀降級），每層對應獨立 probe，且不得互相混用。

#### Scenario: 五層狀態可獨立觀測

- GIVEN 一個 instance 具備完整 probe
- WHEN 查詢 health/readiness
- THEN MUST 能分辨 process alive、dependency reachable、可承接新工作、可 resume、以及 degraded 五種狀態
- AND 每層狀態 MUST 有明確、型別化、non-leaking 的輸出

#### Scenario: degraded 與 ready 可並存表達

- GIVEN 必要 read dependency 可用但部分 write dependency 降級
- WHEN 查詢 readiness
- THEN MUST 回報 degraded（唯讀），而非誤報 fully ready 或 fully down

### Requirement: readiness fail-closed

readiness MUST 在「endpoint 宣稱的工作類別無法安全承接」時回傳 not-ready（fail-closed）。durable dependency 不可用時 MUST NOT 回傳 success，也不得以 process alive 冒充 ready。

#### Scenario: durable dependency 不可用時 not-ready

- GIVEN 一個 instance 宣稱可承接新工作
- WHEN 其 durable dependency（Postgres／checkpoint store）不可達
- THEN readiness MUST 回傳 not-ready
- AND MUST NOT 回傳 success 或僅回報 process alive

#### Scenario: 無法 resume 時不宣稱 resume-ready

- GIVEN checkpoint store 或 recovery port 不可達
- WHEN 查詢 resume-ready
- THEN MUST 回傳 not-ready
- AND MUST NOT 宣稱可 resume durable work

### Requirement: 版本化 deployment policy 承載 SLO/RTO/RPO

MUST 提供版本化 `DeploymentPolicy`（含 availability target、latency/error budget、RTO、RPO、backup cadence、retention、restore-drill 門檻），由 config 載入並附 safe default 與 Zod validation；未知欄位 MUST fail-closed。

#### Scenario: policy 通過 schema 驗證

- GIVEN 一份含 availability target、error budget、RTO、RPO 的 deployment policy
- WHEN 以 policy schema 解析
- THEN MUST 通過並回傳 typed 值
- AND 每個門檻 MUST 為合法數值（正數、RTO≥RPO 等一致性）

#### Scenario: 未知 policy 欄位 fail-closed

- GIVEN policy 含未知或未來欄位
- WHEN 解析
- THEN MUST fail-closed
- AND MUST NOT 以推導值靜默補齊

#### Scenario: 缺 policy 時使用 safe default 並標示

- GIVEN 未提供 deployment policy
- WHEN runtime 啟動
- THEN MUST 使用 safe default 並於 health 輸出標示為 default（非實測）

### Requirement: RTO/RPO 來自 policy 與 measured evidence

RTO/RPO 值 MUST 由 deployment policy 與 measured evidence 產生，MUST NOT 寫死為 source-code constant。restore drill 完成後 MUST 記錄實測 RPO/RTO 並與 policy 目標比較。

#### Scenario: 實測 RPO/RTO 與目標比較

- GIVEN 一次 restore drill 於隔離環境完成
- WHEN 量測實際 RPO 與 RTO
- THEN MUST 記錄實測值並與 policy 目標比較
- AND 未達目標時 MUST 標示為未達標，不得宣告達標

#### Scenario: source code 不含寫死的 RTO/RPO

- GIVEN 檢視 runtime source
- WHEN 查詢 RTO/RPO 值
- THEN MUST 不存在寫死的 RTO/RPO 常數
- AND 值 MUST 一律自 deployment policy 讀取
