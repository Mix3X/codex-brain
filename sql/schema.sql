-- claude-nas-mem schema. Runs once on Postgres first init.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS projects (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memories (
  id         BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('observation','summary','prompt')),
  session_id TEXT,
  machine    TEXT,
  content    TEXT NOT NULL,
  metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding  vector(384),
  -- 'simple' config: language-agnostic, works for mixed FR/EN without stemming surprises
  fts        tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  -- de-dupe key for idempotent migration/inserts
  content_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- idempotent inserts: same logical memory never duplicated
CREATE UNIQUE INDEX IF NOT EXISTS memories_hash_uniq
  ON memories (content_hash) WHERE content_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS memories_fts_idx   ON memories USING gin (fts);
CREATE INDEX IF NOT EXISTS memories_lookup_idx ON memories (project_id, kind, created_at DESC);

-- HNSW: no training step (unlike ivfflat), good recall for concurrent multi-writer.
-- Only used when embeddings are enabled; harmless otherwise.
CREATE INDEX IF NOT EXISTS memories_embedding_idx
  ON memories USING hnsw (embedding vector_cosine_ops);
