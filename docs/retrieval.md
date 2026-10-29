[← 回到 README](../README.md)

# 知識庫檢索

- **知識庫檢索**：以 PostgreSQL + pgvector 儲存私有語料的向量索引。檢索流程為「候選召回 → rerank → 證據門檻 → 引用綁定」；每個引用都可回溯到已儲存的語料片段與其來源版本。沒有任何片段達到門檻時，回答會明確表示語料中沒有相關依據，而不是改用模型自身知識作答。

## 資料與索引邊界

知識庫使用與 LangGraph checkpoint **分開**的資料庫，連線字串以 secret reference 解析，不在工具或流程內直接讀取環境變數。

檢索行為以下列設定控制。Embedding 模型識別與維度屬於版本化設定；維度改變需要重建索引，不會靜默混用。

檢索為 tenant 範圍內查詢，tenant 只由 Server 端 context 決定，不接受來自模型輸出或客戶端的宣稱。來源文件刪除時，其片段與索引項目會一併移除。

## 匯入與續跑

### 準備知識庫

Gun Shop 的商品查詢與政策問答需要先匯入語料。先啟動一個帶 `pgvector` 的 PostgreSQL（可直接用 Compose 的 `knowledge-postgres`），確認 `KNOWLEDGE_DATABASE_URL` 指向它，然後：

```bash
cd backend

# 產生合成語料（商品與政策／FAQ 文件，標記為合成資料）
npm run knowledge:corpus

# 建立知識庫結構並匯入
npm run migrations:up
npm run knowledge:ingest
```

匯入可指定語料目錄與 tenant：

```bash
npm run knowledge:ingest -- --corpus <dir>
npm run knowledge:ingest -- --tenant <tenantId>
```

匯入是可續跑且具冪等性的：中斷後重跑會跳過已完成的片段，重複送出同一份語料不會產生重複資料。每個片段都會記錄來源文件識別、來源版本、位移、資料分級與匯入批次識別。

## 設定與驗證

Embedding、rerank、切塊與門檻的環境變數見[知識庫設定](./configuration.md#知識庫)；完整檢索數據、證據門檻前後的指標定義與重跑方式見[評測](./evaluation.md#檢索品質)。
