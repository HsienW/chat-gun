import fs from 'node:fs';
import {guard,record,runtime,changeId} from './validation-004.mjs';
guard();
const evidence=name=>JSON.parse(fs.readFileSync(`${runtime}/artifacts/${name}-apply-004.json`,'utf8'));
for(const name of ['v2-summary','v3-stream-cancel','v4-browser','v5-resources'])if(evidence(name).status!=='pass')throw Error('required_evidence_not_passed');
const v5=evidence('v5-resources'),reportPath=`openspec/changes/${changeId}/findings.md`,old=fs.readFileSync(reportPath,'utf8');
const oldIndex=old.slice(old.indexOf('| 代號 |'),old.indexOf('\n## task 1.1')).trim();
const historicalIndex=oldIndex.split('\n').filter(line=>!/^\| E(?:2[3-9]|[3-9][0-9]) \|/.test(line)).join('\n');
const newRefs=[['E23','validation','apply-004 前置 strict'],['E24','v2a-reassessment','V2(a) 沿用實測、依新邊界重判'],['E25','v2b-stream','V2(b) running 中 SIGKILL、上游錯誤與 lease TTL'],['E26','v2c-before','V2(c) side-effect 前 SIGKILL'],['E27','v2c-after','V2(c) 執行後 checkpoint 遺失、再次核准'],['E28','v2-summary','三個時點硬性不變量總結'],['E29','v3-stream-cancel','真實串流、斷線 terminal、lease 指令'],['E30','v4-browser','實際瀏覽器操作紀錄、state 與帳本'],['E31','v5-resources','假模型 280 輪、完整時間序列與重啟'],['E32','settings-scan','公開檔案與本輪證據秘密掃描'],['E33','final-checks','最後測試、strict、範圍與檔案指紋'],['E34','schema-validation','result／handoff／CurrentState schema'],['E35','cleanup','隔離容器清理，保留 volumes／映像']];
const index=newRefs.map(([id,name,text])=>`| ${id} | [${name}-apply-004](../../../${runtime}/artifacts/${name}-apply-004.json) | ${text} |`).join('\n');
const priorTechnical=old.slice(old.indexOf('## task 1.1'),old.indexOf('## V0 至 V5')).replace('其餘時點未驗證','其餘時點見 E24～E28');
const mib=value=>(value/1024**2).toFixed(2);
const daily=v5.days.map(d=>`| ${d.day} | ${d.runs.length} | ${mib(d.peakRssBytes)} | ${mib(d.peakDirectoryBytes)} | ${d.startToReadyMs} | ${d.writeGap.maximumMs} | 相同 |`).join('\n');
const text=`# 自建 runtime 可行性驗證結果

結論：**技術上有條件採用，限單一實例 demo**。本 Change 的 V0～V5 均取得所要求的證據；V2 三個時點沒有觀察到重複 side-effect、同一 run 的 terminal 倒退或無法 deserialize。持續活動會重設寫檔計時，SIGKILL 可遺失最近一次充分閒置寫檔之後的整段活動。以下限制須由下游部署規格明示；本報告不代表 readiness 或最終驗收。

## 證據索引

原始證據保存在本 Change 的本機 Runtime Artifact，不進 Git。E1～E22 保留歷史實測；V1 當前標準以 E15 為準，V2(a) 當前判定以 E24 為準，E18 的舊資料年齡標準已由 attempt 6 取代。

${historicalIndex}
${index}

${priorTechnical}
## V0 至 V5

| 項目 | 結果 | 證據／限制 |
| --- | --- | --- |
| V0 shopping_assistant | 通過：server checkpointer 生效，SIGTERM 後 values／history 相同 | E7、E11 |
| V0 deep_researcher | 通過：server 覆蓋自帶 MemorySaver，重啟可讀 | E7、E11 |
| V1 正常重啟 | 通過新版對照；side-effect 各一次，兩邊重放皆 no-op、audit 皆 0 | E8、E15；F003 仍是既有產品缺口 |
| V2(a) interrupt 後立即 SIGKILL | 通過新遺失邊界；7 個 checkpoint／2 則訊息／interrupt／新 run 遺失 | E16、E19、E24；最老 4,824 ms |
| V2(b) 串流中 SIGKILL | 通過；running 中終止，BFF upstream_stream_error，lease 在 TTL 內回收 | E25；2 個 checkpoint 遺失，最老 874 ms |
| V2(c) side-effect 前 | 通過不變量；最終 dispatch 0，操作 failed、再次核准安全拒絕 | E26；審批消費 SQL 與程序終止非原子操作 |
| V2(c) side-effect 後 | 通過；新 checkpoint 遺失並恢復等待審批，再核准仍只有一次 side-effect | E27；5 個 checkpoint 遺失，最老 1,131 ms |
| V3 串流／取消 | 通過；3 個串流段，斷線後 interrupted，terminal 確認後 lease 移除一次 | E29；使用真實模型 |
| V4 瀏覽器相容 | 通過；Gun Chat、研究開關與回答、退款 UI 核准及已確認卡片 | E30；合成訂單與真實模型，未修改產品 |
| V5 資源 | 通過；280 輪、7 天、依序、每天之間重啟 | E31；本機假模型，只驗證資源 |

### V2：遺失範圍與一次性防線

V2(a) 沿用 apply-003，不重跑模型。最近一次 checkpointer 寫檔為 **2026-11-18T14:41:35.176Z**；新活動始於其後，最早遺失 checkpoint 為 14:41:43.004Z，實際 SIGKILL 退出為 14:41:47.828Z，年齡 **4,824 ms**。舊 V0 thread 重讀成功。依新標準全部遺失均在最近一次充分閒置寫檔後，故通過。E24 同時引用原始 API、檔案、來源與 survivors；不以 404 當作 deserialize 失敗。

各檔案的存取與寫入計時獨立；串流案例採 run 前明確閒置至少 3,500 ms 的共同基準，而非把 run 中較新的單一檔案 mtime 當作完整 durable 邊界。V2(b) 的該基準最近寫檔為 2026-11-19T05:20:33.845Z；重啟後 thread 可讀、新 run 未保留。BFF 的 SSE error 為 upstream_stream_error；lease 到期為 05:23:05.041Z，首次觀察消失為 05:23:05.306Z。E25 保留實際指令、HTTP、時間與修正觀察器前的原始資料。

V2(c) 執行前案例以隔離資料庫列鎖固定 consume 等待點，查到 transactionid lock 與 blocking PID，SIGKILL 前成功 dispatch／committed effect 均為 0。程序連線終止後列鎖解除，已送出的 SQL 仍在 PostgreSQL 完成審批消費；重啟時 approved 保留，再次核准回 CONFIRMATION_REPLAYED_OR_EXPIRED 並 audit，最終 dispatch 仍為 0、訂單操作 failed。這是已量測的中斷結果；不把零次錯稱重複，也不聲稱該操作成功。E26。

V2(c) 執行後案例先證實 committed effect／成功 dispatch 各 1，且磁碟仍是原等待審批 checkpoint，才送 SIGKILL。重啟遺失 5 個新 checkpoint，回到同一 approvalId 的等待審批；再次核准未進 physicalDispatch。擋下機制是既有 **PgAuthorizationConfirmationStore.consume**：authorization_confirmations 的條件式 UPDATE 要求 status=pending；原 approved 已在 PostgreSQL，第二次更新沒有結果，回 CONFIRMATION_REPLAYED_OR_EXPIRED 並產生一次 rejected audit。最終 dispatch／committed effect 仍各 1。最近閒置寫檔為 2026-11-19T05:27:11.356Z，最早遺失資料 1,131 ms。E27。

保留的同一 run 均未從 terminal 回到 pending／running；未保留的新 run 屬核准範圍內資料遺失。V2 使用真實 graph、模型、checkpoint 檔與 PostgreSQL 帳本。E24～E28。

### V3、V4：傳輸與瀏覽器

V3 Gun Chat 三段到達時間為 05:28:22.239Z、05:28:22.324Z、05:28:28.738Z，run success。此設定下答案以完整訊息到達，不把 metadata／values 事件冒充逐 token 答案串流。深度研究在 running 中於 05:28:29.883Z 斷線，05:28:29.903Z 已讀到 interrupted；BFF 於 05:28:30.404875Z 記錄 run_cancel_confirmed，Redis MONITOR 記錄其後唯一一次 ZREM。E29。

V4 以實際瀏覽器開啟 BFF /app/：Gun Chat 回覆「瀏覽器測試成功」；開啟研究 switch 後完成資料備份回答；Gun Shop 退款顯示等待審批，按核准後呈現「已確認／已完成」，帳本成功 dispatch 一筆。研究配額耗盡時 UI 顯示限制與重試時間；搜尋的 EGRESS_DENIED 也以原錯誤顯示，沒有吞掉錯誤。測試價格項目缺少 UI 模型時曾拒絕；補齊 Git 忽略的合成 fixture 後重測成功。完整操作紀錄、實際 state、BFF 日誌及資料庫見 E30；補充見 v4-initial-observation、v4-fixture-adjustment、v4-quota-observation、v4-environment。

### V5：資源與寫檔間隔

**使用本機假 OpenAI-compatible 模型端點，沒有據此判定模型語意。** 共 4 位邏輯訪客 × 10 輪 × 7 天＝280 輪；以每天四個 thread 代表訪客，各連續十輪，並行為 1。日間 SIGTERM 重啟六次，整週後再重啟一次量測載入；四個當日 thread 的 values 指紋均相同。此加速方式不代表真實七天的時間分布或瀏覽器 session 壓力。E31。

| 天 | 成功輪數 | 峰值 RSS（MiB） | 峰值目錄（MiB） | start 至 ready（ms） | 最長未寫檔（ms） | 重啟 state |
| --- | --- | --- | --- | --- | --- | --- |
${daily}

整週採樣峰值 RSS **${mib(v5.peakRssBytes)} MiB**，低於 1 GiB；目錄 **${mib(v5.peakDirectoryBytes)} MiB**，低於 500 MiB。最長觀察未寫檔間隔 **${v5.longestUnwritten.maximumMs} ms**，詳見 E31 的檔案、前後時間與採樣。目標採樣週期 100 ms，實際最大採樣間隔 **${v5.observedSampling?.maximumGapMs} ms**，各日均涵蓋完整流量期間。數值包含 BFF 限流等待及結尾閒置；無資料變更的閒置也會使「未寫檔間隔」增加，因此不能直接等同遺失資料年齡。採樣只讀檔案系統，不會重設 API debounce；RSS 為 /proc/1 的 runtime 程序，未包含採樣間及停止／載入瞬間可能漏過的短暫峰值。

第一次量測於第 142 輪遭 BFF 429，僅完成 141 輪，保留 v5-initial-attempt，未當作整週通過。完整重跑沿用相同設定，依明確的 retryAfter 等待再送出；沒有改限流。第 5 天完成流量與完整採樣後，採樣器關閉超過原 3 秒等待；保留 v5-sampler-attempt，補完該天重啟比對再接續最後 80 輪，沒有重送前 200 輪。完整一次的假端點計數恰為 280，所有接受的 run 都驗證固定測試回應。E31 的 throttles 與 resumeInfo 保存等待與續跑紀錄。

### 既有缺口與部署條件

F003：兩邊對已無 interrupt 的相同 resume 都回 no-op／success，沒有 rejected audit；新版 V1 對照通過不代表完整產品重放拒絕契約已符合。此缺口維持後續產品 Change。E15。

F004：三秒是存取後重新計時，沒有資料年齡硬上限。attempt 6 已明訂本 spike 接受的遺失邊界；V2 依該邊界通過，仍須在下游部署聲明持續活動可整段遺失。下游須加停止緩衝時間、記憶體上限與監控，以降低 SIGKILL 機率。本 Change 不實作下游部署防護。E17、E24～E28、E31。

## Requirement 逐條對照

判定只及於本 spike 的實測前提；未驗證的完整產品能力不推定符合。

### durable-hitl-conversation-recovery

| Requirement | 判定 | 證據／理由 |
| --- | --- | --- |
| 統一 DurableInterruptManifest 持久化 | demo 下偏離 | PostgreSQL 審批資料可保留，但 server checkpoint 可在 SIGKILL 遺失或回到較舊等待點；完整 manifest 一致性矩陣未驗證；E24、E26、E27 |
| resume 只回到預期 waiting Task 且最多消費一次 | demo 下偏離 | checkpoint 回退後再次核准由 durable confirmation 擋下；HTTP 層 no-op 重放仍無拒絕 audit；E15、E27 |
| RecoverySanitizer 於 resume 前驗證 protocol-validity | 未驗證 | 實際 checkpoint 可讀與安全拒絕有證據；未單獨覆蓋 sanitizer 的全部不完整資料拒絕矩陣；E26、E27 |
| LastExecutionPointClassifier 分類最後持久化進度 | 未驗證 | API 狀態與業務帳本已保存；沒有單獨執行 classifier／manifest 完整分類矩陣；E24～E28 |
| cancellation reason 與 transport disconnect 分離 | 符合（本次傳輸路徑） | BFF 分別記錄 client disconnect、terminal interrupted 與確認後釋放；未驗證所有取消原因；E29 |
| CrashTerminalPolicy 明確定義 | demo 下偏離 | 未落盤的新 run 可完全遺失；保留的 terminal 沒倒退，但不提供所有 crash 都有 durable terminal 的保證；E24～E28 |
| recovery integration 使用實際 checkpoint | 符合（指定 drills） | V0、V1、V2 三個時點均使用真實 graph／checkpoint／帳本；E7、E8、E15、E24～E28 |

### langgraph-runtime-boundary

| Requirement | 判定 | 證據／理由 |
| --- | --- | --- |
| 現況盤點（Graph 編譯與 Checkpointer 使用） | 符合（指定兩類） | 五個 graph 載入，指定 shopping_assistant 與 deep_researcher 優先順序實測；其餘 graph 未逐一驗收；E1、E7、E11 |
| langgraph dev 生命週期實證 | 符合（本 spike） | 同環境啟動／ready、SIGTERM 對照、SIGKILL 與日間重啟都有實證；E3、E15、E24～E31 |
| Checkpointer 與持久化邊界驗證 | demo 下偏離 | server 覆蓋 graph saver，閒置後落盤，持續活動可能延後整段寫檔；E7、E17、E24～E28、E31 |
| 原生訊號到 Chat-Gun 概念的映射 | 符合（實測路徑） | upstream_stream_error、斷線 interrupted、等待／已確認 UI 都保持可辨識；E25、E29、E30 |
| 權威來源定義 | demo 下偏離 | run／checkpoint 是單一程序記憶體與具名 volume 檔案，不是 shared PostgreSQL checkpoint；E7、E11、E17 |
| Failure Drills | 符合（本次指定範圍） | interrupt、串流、resume 執行前／後均量測；完整其他故障矩陣未驗證；E24～E28 |
| Decision Record 產出 | 符合（本 spike） | 本報告保存條件、數值、限制與證據索引；E23～E35 |

### multi-instance-operation

| Requirement | 判定 | 證據／理由 |
| --- | --- | --- |
| 多 instance 對 shared durable state 安全並行 | demo 下偏離 | 每個測試拓樸只有一個 runtime，檔案不提供 shared durable state；E7、compose.yaml |
| run/job ownership 以 fencing token 安全 takeover | demo 下偏離 | 無第二 runtime 接手，未測 takeover；compose.yaml |
| 事件 sequence 跨 instance resume 不重算 | demo 下偏離 | 無跨 instance；程序重啟可能回退 checkpoint，未驗證完整單實例 sequence 矩陣；E24～E28 |
| projection 由 authoritative facts 重建 | 未驗證 | state／history 重讀與 UI 完成有證據，未完整驗證 projection 重建矩陣；E15、E30 |
| multi-instance 模式禁止 NoopStepLock | 不適用（本拓樸） | 未啟用 multi-instance profile，不據此宣稱多實例安全；compose.yaml |
| session revocation 與 approval resumption 讀取 durable store | 未驗證（完整 Requirement） | 跨程序 approval 的 PostgreSQL 一次性防線已測；session revocation 矩陣未測；E26、E27 |
| controlled leader election 僅限 singleton work | 不適用（本拓樸） | 沒有第二實例或 leader election；cron 完整矩陣未測；compose.yaml |

### demo-deployment-profile

| Requirement | 判定 | 證據／理由 |
| --- | --- | --- |
| Demo 設定層只能單向依賴通用層 | 未驗證 | 未修改產品；部署 smoke 不取代完整架構驗收；E33 |
| demo 模式以單一開關啟用全部 demo 政策 | 未驗證（完整矩陣） | DEMO_ENABLED 下 ready、lease、取消、研究配額與 resume 已測，其餘政策未全測；E3、E25、E29、E30 |
| demo 模式缺少必要設定時拒絕啟動 | 未驗證（完整矩陣） | 缺模型金鑰仍 ready 是既有缺口；其他必要設定矩陣未測；E3 |
| demo 模式以匿名訪客 session 作為限流 user 維度 | 未驗證（完整矩陣） | 實際瀏覽器可經 BFF 使用；V5 是邏輯訪客 thread，未驗證多 session／IP 隔離；E30、E31 |
| demo 准入政策套用全站與分入口每日上限 | 未驗證（完整矩陣） | 已觀察研究日配額與 BFF 429；完整金額／入口上限矩陣不在本次量測；E30、E31 |
| demo 模式關閉非開放功能並放行審批 resume | 符合（指定路徑） | 已實際完成瀏覽器審批與 resume，搜尋拒絕可見；其他禁用功能矩陣未測；E27、E30 |

## 交接與限制

本輪補完 2.2、3.1、3.2、4.1，並更新 5.1、5.2。V0～V4 所需模型路徑使用真實 API；V5 明確使用假端點。完整產品套件 lint／test／build、完整 sanitizer／classifier／session revocation 與多實例矩陣未在本輪執行，列入 implementation_result.verification.notExecuted；不把 spike 的指定測試擴充為完整產品驗收。

初次 DB 未 migrations、過晚的串流終止觸發點、Redis lease 鍵名／回應形狀、執行前零次的判定錯誤、一次 provider_error 與 V5 429 均保留原始證據。測試工具依實際輸出修正；沒有變更產品、Prompt、模型語意或開源套件。

完成後交 Qwen review-result；implementationVerified／readinessConfirmed 留待獨立 Gate。E33 記錄本次檔案變更與起始基準比對：工作區原有 docker-compose.yml 修改保留，不歸入本次修改。E32、E34、E35 分別保存秘密掃描、schema 驗證與容器清理；volumes／映像保留。沒有 commit 或 push。
`;
guard();fs.writeFileSync(reportPath,text);
record('report',{status:'pass',reportPath,evidenceIds:newRefs.map(v=>v[1]+'-apply-004'),recommendation:'有條件採用，限單一實例 demo',matrices:27});
console.log(JSON.stringify({status:'pass',reportPath}));
