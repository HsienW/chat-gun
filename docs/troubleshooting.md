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

- **連線被對外連線政策拒絕** — 若使用 fake-ip 模式的代理工具（部分桌面代理軟體預設啟用），容器或行程內解析模型服務網域會得到保留位址區段（例如 `198.18.0.0/15`），對外連線政策會正確地把它判定為非公開位址並拒絕。請改用不發 fake-ip 的連線模式，或讓該網域直連。這是刻意的安全行為，不會為了繞過而放寬位址判定。
- **知識庫不可用** — 檢查 `KNOWLEDGE_DATABASE_URL`。容器內請使用服務名稱與容器埠（`knowledge-postgres:5432`），不要使用主機埠。
- **回覆「語料中沒有相關依據」** — 若查詢的商品或政策確實不在語料中，這是**正確行為**，不是失敗。合成語料只覆蓋固定的商品與政策範圍。
