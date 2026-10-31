[← 回到 README](../README.md)

# 疑難排解

### Frontend 出現 `Invalid URL`

`VITE_LANGGRAPH_API_URL` 必須是完整 URL。若 Frontend 與 BFF 使用同一個 origin，移除這個設定即可。

```env
VITE_LANGGRAPH_API_URL=http://localhost:5173/api/langgraph
```

### `/api/langgraph/*` 回傳 502

先確認 BFF 與 Backend 狀態：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/ready
Invoke-RestMethod http://localhost:2024/ok
```

再檢查 `BFF_LANGGRAPH_API_URL` 是否指向正在執行的 LangGraph API。

### `Research synthesis failed ... fetch failed`

確認模型或 Tool provider 的 API key、base URL 與網路連線。使用 Qwen／Alibaba Cloud Bailian 時，可以先測試：

```powershell
Test-NetConnection dashscope.aliyuncs.com -Port 443
```

需要 proxy 時，在 `backend/.env` 設定 `HTTPS_PROXY`、`HTTP_PROXY` 與 `NO_PROXY`，然後重新啟動 Backend。

### 商品查詢或政策問答失敗

依錯誤分類處理：

- **連線被對外連線政策拒絕（`EGRESS_DENIED`）** — 表示政策已判定不允許連線。若 reason 是 `PRIVATE_ADDRESS`，代表目的地或任一 DNS 解析結果為非公網位址。使用 Clash、sing-box、Surge 等 TUN／fake-ip 工具時，容器或行程內可能解析到保留位址區段（例如 `198.18.0.0/15`），政策會正確拒絕。請把下列實際使用的目的地加入代理工具的 fake-ip 排除清單，讓 DNS 回傳真實公網位址，或改用不發 fake-ip 的連線模式。僅調整流量直連規則，未必會改變 DNS 結果；請確認容器或行程內的解析結果。若目的地本來就是非公網位址，應檢查端點設定，不要放寬位址判定。
- **對外連線政策無法完成評估（`EGRESS_POLICY_UNAVAILABLE`）** — 表示尚未完成政策判定，並非已判定目的地不允許。目前 `DNS_RESOLUTION_FAILED` 屬於此類，請檢查容器或行程所用的 DNS、網路連線及代理工具的 DNS 設定。此時仍不會放行連線；應先修復解析問題，不要藉由擴大允許清單處理。
- **知識庫不可用（`KB_STORE_UNAVAILABLE`）** — 檢查 `KNOWLEDGE_DATABASE_URL`。根目錄 `docker-compose.yml` 透過 `${KNOWLEDGE_DATABASE_URL:-…}` 設定 `langgraph-api` 的環境變數，因此主機根目錄 `.env` 中供本機開發使用的值也會進入容器；shell 中同名變數會優先於 `.env`。若該值指向 `localhost` 與主機埠，容器會連到自己，可能造成此錯誤。容器內請使用服務名稱與容器埠（`knowledge-postgres:5432`），不要使用主機埠。可移除主機 `.env` 中這個覆寫值，並確認 shell 沒有同名覆寫，讓 Compose 採用預設連線設定（變數未設定或為空時生效）；或在啟動 Compose 的 shell 提供適用容器的連線字串，再由部署者重建受影響容器以套用設定。不要把含帳密的連線字串貼到日誌或問題回報中；此錯誤也可能有其他資料庫原因，不能只憑錯誤碼斷定是連線位址問題。
- **回覆「語料中沒有相關依據」（`no_source_found`）** — 若查詢的商品或政策確實不在語料中，這是**正確行為**，不是失敗。合成語料只覆蓋固定的商品與政策範圍。

fake-ip 排除清單應依實際端點設定調整。目前程式與 Compose 預設涵蓋：

| 用途 | 目的地網域 |
| --- | --- |
| knowledge embedding 模型服務 | `dashscope.aliyuncs.com`（`QWEN_BASE_URL` 預設值） |
| knowledge rerank 模型服務（選用） | `KB_RERANK_URL` 所設定的 hostname；沒有固定預設網域 |
| 天氣與地理編碼 | `api.open-meteo.com`、`geocoding-api.open-meteo.com` |
| 搜尋（`web_search`） | `api.tavily.com` |

支援 `+.` 語法的工具可用 `+.aliyuncs.com`、`+.open-meteo.com` 涵蓋對應子網域，並加入 `api.tavily.com`；不同工具與版本的排除欄位、語法可能不同，請依使用中的版本設定。若覆寫了 `QWEN_BASE_URL` 或設定了 `KB_RERANK_URL`，也要排除實際 hostname。`web_fetch` 的目的地依抓取網址而定，不在這份固定清單內。fake-ip 排除只修正 DNS 行為，不會擴大應用程式的 egress 允許範圍；也不要直接替換整份 DNS 設定，以免影響其他連線。

需要查看 reason 時，可從以下位置核對 `errorCode` 與 `egressReasonCode`：

- Backend 的 `[metric] knowledge.model.usage` 用量事件：egress 失敗時會附 `egressReasonCode`，例如 `PRIVATE_ADDRESS` 或 `DNS_RESOLUTION_FAILED`。
- `kb_search` 的錯誤結果：query embedding 遇到 egress 失敗時，`outcome` 為 `error`，並保留分類與 reason，不會改成 `no_source_found`。若只有 rerank 失敗，仍可能以 recall-only 完成，原分類與 reason 會留在結果的 `retrieval.degradation.egressErrorCode`、`retrieval.degradation.egressReasonCode`。
- shopping 的 `shopping.product.lookup_failed`、`shopping.policy.lookup_failed` audit：egress 失敗時會帶 `egressReasonCode`。依 `AUDIT_BACKEND` 設定查看 console 的 `[audit]` 記錄或持久化 audit。

`egressReasonCode` 是可選欄位，非 egress 錯誤不一定帶有此欄位；消費端遇到集合外的 reason 會記為 `UNKNOWN`，不要據此猜測成已知原因。排查時只分享分類與 reason，避免附上含憑證的 URL、解析出的 IP 或私人網路資訊。
