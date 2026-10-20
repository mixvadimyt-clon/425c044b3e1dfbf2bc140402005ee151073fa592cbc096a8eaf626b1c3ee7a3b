-- Уточнённые требования: манифест комплекта, external_id объекта,
-- версии доказательств (правки инспектора не перезаписывают машинный результат).

ALTER TABLE objects ADD COLUMN external_id TEXT;

ALTER TABLE files ADD COLUMN metadata_source TEXT NOT NULL DEFAULT 'FILENAME';  -- MANIFEST | ML | FILENAME
ALTER TABLE files ADD COLUMN authoritative_basis TEXT;                          -- основание выбора редакции

ALTER TABLE evidence_groups ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE evidence_groups ADD COLUMN source TEXT NOT NULL DEFAULT 'MODEL';     -- MODEL | INSPECTOR
ALTER TABLE evidence_groups ADD COLUMN previous_group_id TEXT;
ALTER TABLE evidence_groups ADD COLUMN created_by TEXT;
ALTER TABLE evidence_groups ADD COLUMN reason TEXT;
ALTER TABLE evidence_groups ADD COLUMN reference TEXT;

-- Ожидаемый состав комплекта (из манифеста) — основа статусов полноты
CREATE TABLE expected_documents (
  id            TEXT PRIMARY KEY,
  process_id    TEXT NOT NULL REFERENCES processes(id),
  doc_stage     TEXT NOT NULL,
  discipline    TEXT,
  document_code TEXT,
  file_name     TEXT,
  title         TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_expected_process ON expected_documents(process_id);
