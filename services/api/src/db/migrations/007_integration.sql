-- Обмен с внешней ИС надзора (REQ-INT-01…07): очередь отправки результатов и полученные пакеты документов.

-- integration_outbox из 001: что отправляем и что ответила внешняя ИС
ALTER TABLE integration_outbox ADD COLUMN protocol_id TEXT;
ALTER TABLE integration_outbox ADD COLUMN protocol_version INTEGER;
ALTER TABLE integration_outbox ADD COLUMN idempotency_key TEXT;
ALTER TABLE integration_outbox ADD COLUMN receipt_id TEXT;
ALTER TABLE integration_outbox ADD COLUMN response TEXT;       -- JSON квитанции
ALTER TABLE integration_outbox ADD COLUMN source TEXT;         -- FINALIZED | MANUAL
CREATE INDEX idx_outbox_due ON integration_outbox(sync_status, next_attempt_at);
CREATE INDEX idx_outbox_process ON integration_outbox(process_id, created_at);

-- Пакеты документов, забранные из внешней ИС (REQ-INT-06)
CREATE TABLE integration_inbox (
  id                 TEXT PRIMARY KEY,
  package_id         TEXT NOT NULL UNIQUE,  -- идентификатор во внешней ИС
  title              TEXT,
  external_object_id TEXT NOT NULL,
  object_id          TEXT REFERENCES objects(id),
  process_id         TEXT REFERENCES processes(id),
  status             TEXT NOT NULL CHECK (status IN ('APPLIED','DEFERRED','FAILED')),
  files_count        INTEGER NOT NULL DEFAULT 0,
  accepted_count     INTEGER,
  has_registry       INTEGER NOT NULL DEFAULT 0,
  message            TEXT,
  error              TEXT,
  package            TEXT NOT NULL,         -- JSON пакета как его отдала внешняя ИС
  requested_by       TEXT REFERENCES users(id),
  received_at        TEXT NOT NULL,
  applied_at         TEXT
);
CREATE INDEX idx_inbox_received ON integration_inbox(received_at);

-- Состояние обмена: время и ошибка последнего опроса
CREATE TABLE integration_state (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL
);
