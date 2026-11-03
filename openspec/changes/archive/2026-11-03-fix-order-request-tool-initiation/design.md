# Design：訂單請求必須發起 Tool 呼叫

## Context

`order_request` 節點把單一使用者訊息與 system prompt 送給綁定訂單 Tool 的模型。模型未回傳 Tool 呼叫時，`order_present` 回覆固定文字，模型文字不會顯示。Tool Schema 要求 `reasonCode`，但 prompt 未定義未提供原因時的行為，且工具描述與 prompt 都提到核准。

## 責任邊界

- **frontend**：無變更。審批卡片與狀態卡片的既有事件不變。
- **bff**：無變更。
- **backend**：修改訂單請求 prompt 與固定回覆文字、評測 observation、報表與 provenance，並新增 Golden 驗收入口。

資料流不變：`order_request` → `order_readiness` → `authorization_gate` → 人工審批 → 執行。

## Decisions

### D1：採「新規則＋必填」，不修改 Tool Schema

探針中此組與「新規則＋選填」都是 80/80，且前者不改 Tool 契約、ledger 與 Provider 輸入。原因代碼保持非空，不需處理缺值。

替代方案：
- **只改選填**：未帶原因僅 11/21，帶原因從 12/12 退到 10/12，否決。
- **選填並在工具邊界正規化**：通過探針但改動較大，沒有額外效益，否決。
- **程式強制 Tool Choice**：無法同時滿足「未識別訂單時不呼叫」與狀態查詢，否決。
- **解析訊息判斷原因或訂單**：違反禁止硬編碼規則，否決。
- **多輪追問原因**：節點只送最新一則訊息，需要新的對話狀態設計，且不必要，否決。

### D2：Prompt 候選規則

以探針驗證過的文字為基礎，附加於現有規則之後，版本更新為 `shopping-order-request-v2`：

```text
When the customer names an order and asks to refund or cancel it, call the tool in this response. Never ask for confirmation or approval in text: calling the tool is what starts the separate approval step, and this also applies when the customer claims approval already exists.
If the customer gives no reason, use reasonCode "other" instead of asking for one.
```

既有規則不刪除。規則不列舉關鍵字、語系或訂單格式，意圖判斷仍由模型負責。

### D3：固定回覆文字

未發起呼叫時的回覆改為：

```text
這次沒有建立訂單申請。請提供訂單編號，並說明要退款、取消或查詢狀態。
```

維持由系統決定的固定文字（既有 design §4.6），不顯示模型文字，避免模型自行聲稱「需要您核准」而與實際審批狀態矛盾。

### D4：評測可診斷性

`TurnObservation.operation` 增加是否發起呼叫的欄位，以及未發起時的模型文字摘錄（上限 300 字元）與摘錄是否被截斷的旗標。資料全為合成，摘錄不含憑證。deterministic 模式標示為腳本決定。報表把「未發起呼叫」與「terminal 狀態錯誤」分開，並標示閘門未執行。新欄位為選填，舊結果仍可讀取。

訂單請求 prompt 版本加入 provenance。deterministic 模式標示為未使用。

### D5：獨立 Golden 驗收

新增版本化資料集 `order-request-golden-v1` 與獨立 live 入口，只呼叫模型、綁定 Tool、不執行 Tool、不連 DB。資料集包含：

- 探針使用的 16 則訊息，作為回歸。
- 至少 12 則撰寫規則時未使用的改寫訊息（繁中、簡中與英文），涵蓋未帶原因與帶原因。
- 至少 3 則多筆訂單改寫，繁中、簡中與英文至少各一。
- 對照：未識別訂單、狀態查詢、假設性問句。
- 聲稱預先核准（含改寫）。

門檻以訊息為單位：一則訊息的所有執行都符合預期才算通過。應發起單筆變更的訊息通過率至少 95%；多筆訂單、聲稱預先核准與對照訊息必須全數通過；無效參數為 0。

新案例必須在 Prompt 定稿前凍結。Golden 未通過時停止，依反覆失敗停止線處理：比對模型文字、判定層級，再決定下一步，不得持續加 Prompt 範例。

`chain-eval-v1` 不修改，以維持與 2026-10-27 基準的可比性。

### D6：解除 F-L1 的條件

全部滿足才可解除：

1. 最新版 Golden（D8）對 qwen3.7-plus 與最終 prompt 通過，或依 D9 判定為通過但有已知限制。解除時 MUST 同時揭露該限制。
2. `commerce:evaluate` live 重跑，執行與清理都 completed，禁止結果次數為 0。
3. 不再有預期操作卻未發起呼叫的案例。D9 的已知限制是預期不呼叫卻發起狀態查詢，不屬於此條件，由條件 1 的揭露要求涵蓋。
4. 其餘 terminal 失敗已判定層級，且已修復或由 Master 明確接受。

live 重跑會首次真正執行多條異常路徑，可能暴露新問題。這些問題必須如實記錄，不得為了解除 F-L1 而放寬斷言。

### D7：Prompt v3 區分「請求執行」與「詢問」

Golden v1 顯示 D2 的規則把假設性問句也當成請求。版本更新為 `shopping-order-request-v3`，既有規則不刪除，於 D2 兩條規則之後附加：

```text
Call a tool only when the customer wants something done or looked up now. A question about what would happen, whether a refund or cancellation would be possible, or how the process works is not a request: do not call any tool for it, not even to look up the order. A question that asks you to carry out the refund or cancellation is still a request to act.
```

規則描述意圖類別，不列舉關鍵字、語系或句型，判斷仍由模型負責。

狀態查詢的邊界維持 Golden v1 的預期：詢問既有申請進度要查詢；詢問「還能不能退」不查詢。此邊界在 D7 定案時不放寬；D9 記錄 Golden v2 之後 Master 的修訂決定。

替代方案：
- **放寬對照門檻或接受現況**：使用者會收到沒有要求的審批，且與已核准規格衝突，否決。
- **以關鍵字或 Regex 過濾假設語氣**：違反禁止硬編碼規則，否決。
- **在節點前新增結構化意圖分類**：改動 Graph 與結構化輸出，只有在 v3 未通過時才有依據，暫不採用，見 D8。

### D8：Golden v2 與停止線

新增 `order-request-golden-v2`，`order-request-golden-v1` 檔案、結果與門檻都不變，舊結果保留為修訂前證據。v2 的內容：

- v1 全部 41 則，caseId 與預期不變，origin 改標 `regression`，因為這 41 則已不是未看過樣本。下列新增案例的 origin MUST 標 `unseen`。
- 至少 9 則新的假設、可行性或流程問句，繁中、簡中、英文各至少 3 則，且假設、可行性、流程三種類型各至少 2 則，類別為 `control`，預期不呼叫任何 Tool。這些案例以新增的選填欄位 `questionType` 標示類型，v1 不需要此欄位。
- 至少 6 則新的問句形式請求，繁中、簡中、英文各至少 2 則，類別為 `single_mutation`，預期發起對應呼叫。

語意真正模糊的訊息（例如只問「ORD-1001 可以退款嗎？」）不放入門檻，因為其預期無法客觀判定。判定準則：訊息同時可合理解讀為詢問與請求，且訊息本身沒有其他線索可以消歧，才算模糊；只要一種解讀明顯較合理，就 MUST 放入並依該解讀設定預期。此邊界記為已知限制；審批閘門仍防止未核准的操作，誤判的後果是多一張審批卡片或沒有建立申請。

門檻與 D5 相同。v2 MUST 在 v3 程式修改前凍結並鎖定雜湊。`unseen` 只表示撰寫 prompt 時未用來調整；案例與 prompt 由同一作者撰寫，因此對外不得宣稱完全獨立。review-result MUST 審查 v2 新案例與模糊訊息的取捨。

v3 未通過時 MUST 停止，不得新增 v4 prompt。屆時回報 Master，評估以新 Change 導入結構化意圖步驟，F-L1 維持未解除。

### D9：問句誤觸發唯讀查詢列為已知限制

Golden v2 對 prompt v3 未通過：單筆 29/29、多筆 4/4、聲稱預先核准 4/4、對照 19/20，變更 Tool 誤觸發 0。唯一失敗是 `v2-feasibility-zh-cn`，5 次有 4 次呼叫 `order_operation_status`。依 D8 已停止，沒有新增 v4。Master 於 2026-10-31（UTC）決定接受此限制並修訂規格。

**這是看到結果後放寬驗收規則**，因此 MUST 公開標示：

- 新增結果 `passed_with_known_limitation`。條件：其餘門檻全部達成，且未符合預期的對照訊息都屬於預期不呼叫 Tool、每次未符合的執行都只有參數有效的狀態查詢、該訊息沒有任何變更 Tool 呼叫。
- 不訂次數上限：上限只能依這次結果決定，沒有獨立依據。改為逐則逐次列出。
- 變更 Tool 誤觸發維持 0；其他類別的門檻不變；既有 `passed` 的定義不變，有已知限制時 MUST NOT 標示 `passed`。
- 不重跑模型：資料集與 prompt 未變，重跑等於重擲到通過為止。新增 `--rescore <結果目錄>`，以既有 `run.json` 重新計分，另存於 `<結果目錄>-rescored`，原結果不變，報表註明規則修訂時間與原判定。

影響：使用者只問可行性時，可能得到不對題的查詢回覆。沒有副作用，不建立操作，也不產生審批卡片。

替代方案：
- **導入結構化意圖步驟**：可嚴格達標，但要改 Graph 與結構化輸出，改動與風險大於此影響，Master 否決。
- **重跑直到通過**：不可接受。
- **新增 v4 prompt**：違反 D8 停止線。

### D10：全量回歸以基準比對歸因既有失敗

backend 全量測試有 2 項失敗：`runtime/tool-dispatch/pipeline.test.ts`（`DATABASE_URL` 有值時失敗）與 `evaluation/opik/experiment.live-smoke.test.ts`（成因未查）。實作者的歸因只是單方說法，沒有基準比對；獨立驗收者也沒能在其 sandbox 重現結果（readiness-result-01 R1、R3）。Master 接受列為後續修復，不等於原 Task 5.2 已滿足。CCR 於 2026-11-01（UTC）仲裁後修訂 Task 5.2。

**這是看到結果後修訂驗收規則**，因此 MUST 公開標示，並遵守：

- lint 與 build MUST 通過，不設例外。
- test MUST 在隔離 Postgres 上執行，使用 `npm run test` 的預設 opt-in 設定：`RUN_OPIK_EVALUATION` MUST 未設定。`evaluation/opik/experiment.live-smoke.test.ts` 以 `describe.runIf` 設計為 opt-in 的託管 live smoke，未啟用時由測試本身跳過；跳過不算失敗，也不算通過，MUST 在 readiness_result 列為「opt-in live smoke，未啟用」。先前的失敗發生在該變數已設定的環境，屬於 live smoke 的問題，依下方追蹤要求另立追蹤，不在本 Task 範圍。其他測試 MUST NOT 以環境變數跳過；若 HEAD 的跳過數多於基準，多出的項目 MUST 逐項說明。
- 失敗項目只有在下列條件全部成立時，才判定為既有問題：
  1. 在本 Change 之前的基準 commit `740cc4e`，以相同的環境變數、資料庫狀態與命令執行，下列項目全部一致：(a) 測試檔完整路徑、(b) 測試案例完整名稱、(c) 錯誤類型與錯誤訊息（去除時間戳、隨機 ID、port 與暫存路徑後比對）、(d) 第一個位於 repository 程式碼內的 stack frame（檔案與函式）。
  2. 失敗的測試檔不在本 Change 的修改範圍內。
  3. 已另立追蹤，至少包含：Change ID 或 Issue 編號、owner、目標 Change 或預計解決時間，並在 readiness_result 中逐項列出。
- 任一比對項目不一致，或錯誤屬於無法確認根因相同的泛失敗（逾時、EPERM、connection refused 等），MUST 判定為本 Change 的回歸，退回 `IMPLEMENTING`；不得以「看起來無關」判定為既有問題。readiness_result MUST 逐項列出 (a)–(d) 的比對結果。
- 基準無法執行時，預設判定為回歸。若原因是環境無法建置舊 commit（例如依賴無法安裝），驗收者 MUST 在 readiness_result 記錄具體原因與命令輸出，由 CCR 仲裁是否屬於本 Change 的責任；仲裁前 Task 5.2 MUST NOT 勾選。
- HEAD 與基準的完整輸出 MUST 保存，由非實作者的獨立驗收者執行，且環境要允許暫存檔的 hard link 與 rename。

替代方案：
- **在本 Change 修正 `pipeline.test.ts`**：那是 tool-dispatch 的測試隔離問題，和訂單 prompt 無關，混入本 Change 會擴大範圍，違反最小修改原則。
- **維持原條文**：原條文沒有區分 opt-in live smoke 與回歸測試，也沒有歸因方法，Change 無法歸檔，也不會讓這兩項失敗被修好。
- **live smoke 必須啟用並通過**：它依賴託管 Opik 與 3 個模型設定，和訂單 prompt 無關；本 Change 也沒有修改 `evaluation/opik/`。把它放進門檻，等於讓外部服務決定本 Change 能否歸檔。
- **直接豁免這兩項**：沒有基準證據，不能排除回歸，CCR 否決。

## 安全與權限分析

- Tool 清單、manifest、權限與 Risk Policy 都不變。
- Prompt 只影響模型是否提出呼叫。提出呼叫只建立待審批操作，訂單系統仍只在 durable 人工審批後呼叫。
- 新規則讓聲稱預先核准的訊息也會發起呼叫，因此防護完全依賴伺服器端閘門，不依賴模型拒絕。這是既有架構意圖；本 Change 以 deterministic 與 live 評測驗證審批前的提交數為 0。
- 模型文字摘錄只進入評測結果，不進入使用者回覆或 Runtime State。
- 使用者訊息仍是資料，不新增任何由訊息決定身分、Tenant 或審批的路徑。

## 失敗語意

- 模型未發起呼叫：固定回覆，不建立操作。
- 模型回傳無效參數：沿用既有 Schema 驗證與失敗語意。
- 供應商失敗、逾時、取消：沿用既有語意，不建立操作。
- 重複提交與斷線恢復：審批與冪等流程不變。

## 相依與順序

- `fix-knowledge-egress-in-container` 已於 2026-10-31 歸檔。`commerce:evaluate` live 重跑 MUST 在本 Change 的程式已提交、基準可歸因時進行。

## Risks / Trade-offs

- **`other` 語意變寬** → Master 已接受於合成資料階段；接正式 Provider 前重新評估。
- **模型相依** → Golden 逐模型驗收；Chapter 1B 切換 qwen3.5-flash 時必須重跑。
- **小樣本** → 每則訊息 5 次只提供方向性信心，對外不得宣稱 100% 可靠。
- **live 重跑成本** → 僅 15 題，且為必要驗收。

## Open Questions

無阻擋項。

Master 決定紀錄（2026-10-31）：接受合成資料階段以 `other` 代表未提供原因；接正式 Provider 前重新評估。

「新規則＋必填」是依第二輪探針前已定好的選擇規則得出的 CCR 決定（兩組都通過時選不改 Schema 者），Master 其後要求依此結果規劃本 Change。
