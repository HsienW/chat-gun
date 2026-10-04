# Tool 與 MCP 安全設定

<p>
  <a href="./tool-security-isolation.en.md">English</a> |
  <a href="./tool-security-isolation.md">繁體中文</a>
</p>

經由 `backend/src/tools/registry.ts` 載入的 native Tools 與 MCP Tools，都會先套用 `backend/src/platform/tool-governance.ts`。直接由 graph 匯入的 Tool 不會自動取得這層保護；新增 Agent 或 Tool 時應優先使用 Registry，或在呼叫端提供等效限制。高風險 Tool 仍需保留自己的輸入與網路／檔案系統限制。

## Tool allowlist 與 denylist

`TOOL_ALLOWLIST` 非空時，只載入列出的 Tools。`TOOL_DENYLIST` 永遠優先封鎖符合的名稱。

```env
TOOL_ALLOWLIST=calculator_tool,web_search,web_fetch,current_weather,weather_forecast
TOOL_DENYLIST=web_fetch
```

也可以單獨停用 Tool。名稱會轉成大寫並以底線分隔：

```env
TOOL_WEB_FETCH_ENABLED=false
```

## 執行限制

預設設定：

```env
TOOL_AUDIT_ENABLED=true
TOOL_TIMEOUT_MS=15000
TOOL_MAX_INPUT_CHARS=8000
TOOL_MAX_OUTPUT_CHARS=24000
```

每個 Tool 都可覆寫：

```env
TOOL_WEB_FETCH_TIMEOUT_MS=12000
TOOL_WEB_FETCH_MAX_INPUT_CHARS=4000
TOOL_WEB_FETCH_MAX_OUTPUT_CHARS=12000
```

輸入超過上限時不執行 Tool。輸出超過上限時會截斷。Timeout 與呼叫端 cancellation 會透過 `AbortSignal` 傳入 Tool；Tool 本身仍需支援 signal，才能中止已開始的外部 I/O。

## Audit 與 metrics

Governance wrapper 會記錄下列 audit events：

- `tool.load`
- `tool.invoke.start`
- `tool.invoke.success`
- `tool.invoke.failure`
- `tool.blocked`

事件包含 Tool 名稱、耗時、輸入輸出長度；失敗事件也會保留 `Error.message`，但不記錄完整 Tool input。Tool 實作不應把 credential、完整第三方回應或其他敏感資料放入錯誤訊息。Tool 執行也會寫入 metrics；啟用 Opik 時，Tool call 會出現在對應的 Agent trace 下。

## `web_fetch`

`web_fetch` 只接受公開的 HTTP／HTTPS URL，並套用以下限制：

- 拒絕 URL 內嵌帳號或密碼。
- 預設只允許 port `80`、`443`。
- 拒絕 `localhost`，以及程式明列的 IPv4／IPv6 ranges，包括 loopback、RFC 1918 private IPv4、IPv4 link-local、shared address space、benchmarking、IPv6 unique-local／link-local 與 multicast。
- Domain fetch 前解析所有 DNS results，任一結果落入上述 range 就拒絕。
- 每次 redirect 都重新驗證 URL、port 與 DNS，最多三次 redirect。
- Response body 上限為 1,000,000 bytes。
- 單次 fetch timeout 為 12 秒，外層仍受 Tool governance timeout 限制。
- 回傳文字預設最多 12,000 字元，request 可調整但不超過 30,000 字元。

需要額外 port 時，明確加入 allowlist：

```env
WEB_FETCH_ALLOWED_PORTS=80,443,8443
```

允許新 port 會擴大 outbound access。公開部署仍應在 network layer 加上 egress firewall 或 proxy；application-level URL validation 不能取代完整的網路隔離。

Backend 支援 `HTTPS_PROXY`／`HTTP_PROXY`。Proxy URL 若包含 credential，log 會遮蔽帳號與密碼。

## X25 sandbox、secret broker 與 egress policy 現況

- `TOOL_EXECUTION_PROFILE_ENFORCEMENT_ENABLED=true` 啟用 versioned `ExecutionProfile` enforcement。順序固定為 authorization → profile resolution → capability matching → secret resolution → egress → execution → audit；任一步失敗皆 typed deny，不會回退 host execution。
- 五個既有 read-only native tools明確使用 `trusted_in_process`；MCP filesystem與Brave tools使用 `isolated_process`。目前 repository沒有 production `SandboxRunnerPort`實作，因此啟用 enforcement後的MCP invocation會回 `SANDBOX_RUNNER_UNAVAILABLE`，不會用一般 `spawn`冒充隔離。
- `TAVILY_API_KEY`與`BRAVE_API_KEY`只以 `SecretReference`宣告，並由 `SecretBrokerPort`在最終授權執行端解析。secret value以不可序列化的 Symbol context傳遞，不得進入prompt、tool schema、event、checkpoint、log、trace、receipt或error payload。
- `web_fetch`、`web_search`、Open-Meteo geocoding與weather requests全部經 versioned、deny-by-default egress policy。每次URL與redirect都重新驗證protocol、destination、port與所有DNS results；production transport把核准IP固定到實際socket connect，同時保留TLS server name，以阻斷DNS rebinding。
- audit與structured tool result會記錄 `executionProfileVersion`、`effectiveCapabilities`、`secretRefsUsed`、`egressDecision`與`terminationCause`；只記secret reference，不記credential value。

Rollout前應先配置並驗證 production sandbox runner，再逐環境開啟 `TOOL_EXECUTION_PROFILE_ENFORCEMENT_ENABLED`。若環境需要MCP而尚無runner，應維持MCP停用，不得以關閉安全檢查作為替代。

## Filesystem MCP

MCP servers 只有在 `MCP_LOAD_ON_START=true` 時才會載入。Filesystem MCP 的存取範圍由單一工作目錄與 allowed roots 共同決定：

```env
MCP_LOAD_ON_START=true
MCP_FILESYSTEM_ENABLED=true
MCP_FILESYSTEM_PATH=/srv/chat-gun/workspace
MCP_FILESYSTEM_ALLOWED_ROOTS=/srv/chat-gun/workspace
```

`MCP_FILESYSTEM_PATH` 必須位於至少一個 allowed root 內，否則 Filesystem MCP 會被跳過。未設定 allowed roots 時，預設只允許 Backend process 的目前工作目錄。

多個 roots 使用作業系統的 path delimiter：

```text
Windows: C:\safe-a;D:\safe-b
Linux/macOS: /srv/safe-a:/srv/safe-b
```

不要把 repository root、使用者 home 或整個磁碟設為 allowed root。建議建立專用目錄，並由作業系統限制該 process 的讀寫權限。

## Brave Search MCP

```env
MCP_LOAD_ON_START=true
MCP_BRAVE_SEARCH_ENABLED=true
BRAVE_API_KEY=your_brave_api_key
```

`BRAVE_API_KEY` 只提供給 Brave Search MCP subprocess。內建 `web_search` 使用的是 `TAVILY_API_KEY`，兩者互不共用。

## 部署注意事項

- MCP server 以 stdio subprocess 執行；程式內的 allowed roots 不能取代 container、OS account 或 process sandbox。
- 不要把未知來源的 MCP server 加入 production image。
- Tool／MCP output 是不可信資料，不應直接當成 system instruction、HTML 或 shell command。
- 第三方 Tool output 可能包含個資或 credential；送入 log、trace 或 hosted observability 前應先做欄位 allowlist 與 redaction。
- Tool permission 不應只由模型決定。高風險或有副作用的操作應在可信的 API／service boundary 再做 authorization。
