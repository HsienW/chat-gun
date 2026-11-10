# Demo 成本與存取設定

本文件對應 `demo-cost-and-access-guard` tasks 6.2。程式碼與本機驗證使用單價 fixture；6.4 的官方單價、實際成本量測與 Master 成本驗收完成前不得部署公開 Demo。

## 啟用與依賴

BFF 與 backend 都設 `DEMO_ENABLED=true`；未設定或設為 `false` 時使用通用預設。其他字串拒絕啟動。backend 透過 `langgraph.json` 的 `src/application.ts` 組裝；BFF 仍以 `npm start`／`node dist/server.js` 啟動。兩端不得只開其中一端。

Redis 必須可由兩端存取。backend 擁有用量帳本寫入，BFF 對帳本只使用 GET／HGETALL；BFF 對獨立的 `:admission:` 與限流 key 有寫入需求。以 ACL 區分前綴權限。backend 的 `/internal/usage-ledger/metadata` 回報 wire version、幣別、時區、鍵前綴、共用儲存及單價完整性與連線狀態，不含 URI 或憑證。限制 backend 為內網存取，瀏覽器只連 BFF。

## 必要設定

| 端點 | 設定 | 格式／限制 |
| --- | --- | --- |
| 兩端 | `USAGE_LEDGER_REDIS_URI` | Redis／Rediss URI；憑證由部署 secret 提供 |
| 兩端 | `USAGE_LEDGER_KEY_PREFIX` | 相同、非空、各環境分開 |
| 兩端 | `USAGE_LEDGER_TIME_ZONE` | 相同的 IANA 時區；Demo 使用 `Asia/Singapore` |
| backend | `USAGE_LEDGER_WRITE_TIMEOUT_MS` | 50–5000 毫秒 |
| backend | `USAGE_PRICE_TABLE_JSON` | 下方格式，含全部啟用的 primary、fallback 與 knowledge 模型 |
| backend | `SHOPPING_ASSISTANT_THINKING_ENABLED` | 必須是 `false`，會送出 Qwen `enable_thinking: false` |
| backend | `CHAT_THINKING_ENABLED` | 可省略，Demo 預設 `false`；可明確設 `true`，仍受上限 |
| BFF | `BFF_ALLOWED_ORIGINS` | 非空、無 `*`、逗號分隔的完整 Origin |
| BFF | `BFF_TRUSTED_PROXIES` | key 必須存在；空值表示直連，否則為位址／CIDR，拒絕全開 |
| BFF | `BFF_UPSTREAM_TIMEOUT_MS` | 正整數，整個 leased 請求的絕對期限 |
| BFF | `DEMO_SESSION_SECRET` | 至少 32 UTF-8 bytes，由 secret 管理器注入 |
| BFF | `DEMO_SESSION_LIFETIME_MS` | 正整數毫秒；部署時使用至少 1000 毫秒 |
| BFF | `DEMO_BUDGET_CURRENCY` | 帳本相同的三碼幣別，例如 USD，不換匯 |
| BFF | `DEMO_BUDGETS_JSON` | 正整數 micro-currency：site、gun_shop、gun_chat、deep_research、reserve |
| BFF | `DEMO_GRAPH_BUDGETS_JSON` | graph ID → 預算範圍的設定；只可包含開放的三個 graph |
| BFF | `DEMO_CONCURRENCY_LIMIT` | 正整數；Master 定案為 3 |
| BFF | `DEMO_LEASE_TTL_MS` | 必須比上游逾時多 30000–120000 毫秒，含端點 |
| BFF | `DEMO_RESEARCH_IP_DAILY_RUNS` | 正整數；Master 定案為 2 |
| BFF | `DEMO_BUDGET_TIMEOUT_MS` | 正整數，帳本讀取、連線及准入 Redis 命令上限 |
| BFF | `BFF_RATE_LIMIT_USER_MAX_REQUESTS`、`BFF_RATE_LIMIT_USER_WINDOW_MS` | 明確正整數；30／60000 |
| BFF | `BFF_RATE_LIMIT_IP_MAX_REQUESTS`、`BFF_RATE_LIMIT_IP_WINDOW_MS` | 明確正整數；60／60000 |

BFF 的計數與計時數值均不得超過 2147483647。分入口金額總和不可大於 site。範例金額設定為 `{"site":210000,"gun_shop":125000,"gun_chat":28000,"deep_research":42000,"reserve":14000}`；對應為 `{"shopping_assistant":"gun_shop","chatbot":"gun_chat","deep_researcher":"deep_research"}`。embedding／rerank／vision 只計入 site，reserve 額度不單獨拒絕 graph。

目前只有 Qwen adapter 宣告並實作可切換思考模式的能力；其他 provider 不能只靠設定 `false` 假裝已關閉，Demo 啟動會拒絕。非 Demo 且未指定選項時保留原本 provider payload。參數依據：[Alibaba Cloud 官方思考模式文件](https://www.alibabacloud.com/help/en/model-studio/deep-thinking)。

單價表是一個 JSON array，每筆有 `provider`、`model`、`callKind`（chat／vision／embedding／rerank）、`currency`、十進位字串 `inputPerMillion`／`outputPerMillion`、`source` URL、`verifiedAt`（YYYY-MM-DD）。選填 `missingUsageEstimateMicros` 是明確的缺用量估算值。範例僅供測試：

```json
[{"provider":"qwen","model":"fixture-model","callKind":"chat","currency":"USD","inputPerMillion":"1","outputPerMillion":"2","source":"https://example.test/fixture-pricing","verifiedAt":"2026-11-02"}]
```

同表混用幣別、重複項目或格式錯誤會拒絕啟動。缺單價或缺 provider usage 會記為 unpriced，不能視為免費；啟用金額政策時，模型清單缺價拒絕啟動，當日帳本出現 unpriced 則准入 fail-closed。Demo 組裝點亦注入通用模型單價驗證器，對執行時模型覆寫值在 provider 呼叫前驗證，避免繞過啟動時的模型盤點。帳本保留 48 小時，每日按設定時區切分。

## Cookie、代理與相容性

frontend 與 BFF 必須透過 HTTPS 位於同一個站；同站不等於相同 Origin。前端 fetch 使用 credentials include，BFF 的 CORS Origin 白名單仍需正確。`__Host-demo-visitor` cookie 固定 Path=/、Secure、HttpOnly、SameSite=Strict，沒有可降低 SameSite 的設定。平台的 `vercel.app`、`onrender.com` 屬 Public Suffix List，不同站點的子網域可能互為跨站，應使用同站的自訂網域或同來源反向代理。

cookie 只用於限流 user 維度，不授權，也不改 principal。竄改／過期時重新簽發，不記錄原值。跨站或丟棄 cookie 會失去 session 維度隔離，IP、每日額度及並行仍有效。Redis 限流失敗退回程序內計數；預算或並行資料不可確認時拒絕建立 run。

信任代理清單預設為空，非 Demo 也受新的 IP 解析規則影響：不可信對端提供的 XFF 不採用；可信代理鏈由右往左取第一個不可信位址，全可信鏈取最左邊並標記審計。依實際入口代理網段設定，切勿使用 `/0`、`*` 或無法驗證的網段。

## Run 與 lease

Demo 只開放 chatbot、shopping_assistant、deep_researcher 的 stream／wait；背景單一 run、batch、cron、math_agent、mcp_agent 都拒絕。含 resume 的建立請求也必須帶 `on_disconnect: "cancel"`；不存在／continue、任何 `after_seconds`、`stream_resumable: true` 均拒絕，不改寫 body。resume 跳過金額與每日次數檢查，仍占並行並入帳，維持原本審批與 side-effect 契約。

lease 准入時起算同一絕對期限，換上游或收到 headers 都不重設。正常完成與建立 run 前的 4xx 立即釋放；異常時先 abort transport，對已查證的 threaded Content-Location 呼叫 `POST .../cancel?action=interrupt&wait=true`，再 GET 同 run 確認 success／error／timeout／interrupted 才釋放。兩次 API 共用「最早一個 lease 到期」的等待上限，不另重設倒數。

查證版本為 `@langchain/langgraph-api` 1.4.5，interrupt 與 on_disconnect cancel 的內部 action 相同。若沒有完整 thread/run 識別（包含 stateless 路徑）、cancel 失敗或確認逾時，保留 lease 到 TTL，並記錄穩定事件。這會暫時降低容量。BFF 當機也由 TTL 回收；若上游斷線取消與明確 cancel 同時失效，仍有 run 超過 TTL 的殘餘風險，真實整合必須驗證。

## Ready 與部署前成本驗收

`GET /api/ready` 必須同時確認 LangGraph 與帳本 ready；幣別、時區、前綴不一致、Redis 無法連線或缺價都不 ready。新 run fail-closed；不要以 liveness 取代 ready。

帳本是實際用量累加，沒有預扣。最壞超支估算為：**3 × 單一 run 最大成本 + 預算耗盡後放行 resume 的成本**，另外保留非同步入帳延遲的餘裕。單一 run 成本須以全部 provider 嘗試（重試、fallback、修復、knowledge）計算，不能只取 Graph 可見的最後一次 usage。依 6.4 核實新加坡官方 USD 單價、日期、來源，量測 Gun Shop／Gun Chat／深度研究，交 Master 審閱 6.2 並接受成本。相關另一個模型切換 Change 完成前亦不得部署。

本文件尚待 Master 審閱；單元測試及 fixture 不能代替 6.1 真實整合或 6.4 部署 Gate。
