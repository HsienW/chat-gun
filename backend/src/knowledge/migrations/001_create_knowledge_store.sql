-- migrate:up
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS kb_embedding_space (
  embedding_space_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kb_source (
  tenant_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_version INTEGER NOT NULL CHECK (source_version > 0),
  source_type TEXT NOT NULL CHECK (source_type IN ('product', 'policy', 'faq')),
  title TEXT NOT NULL,
  data_classification TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  corpus_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'deleted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, source_id, source_version)
);

CREATE UNIQUE INDEX IF NOT EXISTS kb_source_one_active
  ON kb_source (tenant_id, source_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS kb_ingestion_run (
  run_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  corpus_version TEXT NOT NULL,
  embedding_space_id TEXT NOT NULL REFERENCES kb_embedding_space (embedding_space_id),
  chunking_policy_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'incomplete')),
  counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS kb_chunk (
  tenant_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_version INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  offset_start INTEGER NOT NULL CHECK (offset_start >= 0),
  offset_end INTEGER NOT NULL CHECK (offset_end > offset_start),
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  data_classification TEXT NOT NULL,
  ingestion_run_id TEXT NOT NULL REFERENCES kb_ingestion_run (run_id),
  embedding_space_id TEXT NOT NULL REFERENCES kb_embedding_space (embedding_space_id),
  embedding vector NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, chunk_id),
  UNIQUE (tenant_id, source_id, source_version, chunk_index, content_hash, embedding_space_id),
  FOREIGN KEY (tenant_id, source_id, source_version)
    REFERENCES kb_source (tenant_id, source_id, source_version) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS kb_chunk_by_source
  ON kb_chunk (tenant_id, source_id, source_version);

CREATE INDEX IF NOT EXISTS kb_chunk_hnsw_text_embedding_v4_1024
  ON kb_chunk USING hnsw ((embedding::vector(1024)) vector_cosine_ops)
  WHERE embedding_space_id = 'text-embedding-v4:1024';

-- migrate:down
DROP INDEX IF EXISTS kb_chunk_hnsw_text_embedding_v4_1024;
DROP INDEX IF EXISTS kb_chunk_by_source;
DROP TABLE IF EXISTS kb_chunk;
DROP TABLE IF EXISTS kb_ingestion_run;
DROP INDEX IF EXISTS kb_source_one_active;
DROP TABLE IF EXISTS kb_source;
DROP TABLE IF EXISTS kb_embedding_space;
