-- Приложение 1 и «Перечень ИД» ред. 1.1 (контракт v0.4): обязательный реестр файлов, поля реестра,
-- повторная загрузка создаёт новую запись (снимаем UNIQUE (process_id, file_hash)), новые перечни статусов.

CREATE TABLE files_new (
  id                  TEXT PRIMARY KEY,
  object_id           TEXT NOT NULL REFERENCES objects(id),
  process_id          TEXT NOT NULL REFERENCES processes(id),
  original_name       TEXT NOT NULL,
  format              TEXT NOT NULL,
  size_bytes          INTEGER NOT NULL,
  file_hash           TEXT NOT NULL,
  file_path           TEXT NOT NULL,
  pages_count         INTEGER,
  stage_hint          TEXT,
  doc_stage           TEXT,
  doc_kind            TEXT,
  discipline          TEXT,
  document_code       TEXT,
  revision            TEXT,
  approval_status     TEXT NOT NULL DEFAULT 'UNKNOWN',
  approval_date       TEXT,
  predecessor_id      TEXT,
  is_authoritative    INTEGER,
  metadata            TEXT,
  metadata_confidence REAL,
  metadata_source     TEXT NOT NULL DEFAULT 'FILENAME',
  authoritative_basis TEXT,
  processing_status   TEXT NOT NULL,
  quality             TEXT NOT NULL DEFAULT '{}',
  parsed_ref          TEXT,
  parser_version      TEXT,
  error               TEXT,
  uploaded_at         TEXT NOT NULL,
  -- реестр файлов
  external_file_id    TEXT,            -- file_id заказчика (ALT79B-000015)
  in_registry         INTEGER NOT NULL DEFAULT 0,
  registry_key        TEXT,            -- какой строке реестра соответствует файл (file_id | file_name | sha256)
  registry_sha256     TEXT,            -- контрольная сумма из реестра (для сверки)
  sheet_page_range    TEXT,
  signature_status    TEXT NOT NULL DEFAULT 'UNKNOWN',
  external_predecessor_id TEXT,        -- ссылки реестра до сопоставления с загруженными файлами
  external_successor_id   TEXT,
  duplicate_of        TEXT             -- повторная загрузка того же содержимого в эту проверку
);

INSERT INTO files_new (
  id, object_id, process_id, original_name, format, size_bytes, file_hash, file_path, pages_count, stage_hint,
  doc_stage, doc_kind, discipline, document_code, revision, approval_status, approval_date, predecessor_id,
  is_authoritative, metadata, metadata_confidence, metadata_source, authoritative_basis, processing_status,
  quality, parsed_ref, parser_version, error, uploaded_at, in_registry
)
SELECT
  id, object_id, process_id, original_name, format, size_bytes, file_hash, file_path, pages_count, stage_hint,
  doc_stage, doc_kind, discipline, document_code, revision,
  CASE approval_status WHEN 'NOT_APPROVED' THEN 'DRAFT' ELSE approval_status END,
  approval_date, predecessor_id, is_authoritative, metadata, metadata_confidence, metadata_source,
  authoritative_basis, processing_status, quality, parsed_ref, parser_version, error, uploaded_at,
  CASE metadata_source WHEN 'MANIFEST' THEN 1 ELSE 0 END
FROM files;

DROP TABLE files;
ALTER TABLE files_new RENAME TO files;
CREATE INDEX idx_files_process ON files(process_id);
CREATE INDEX idx_files_hash ON files(file_hash);
CREATE INDEX idx_files_external ON files(object_id, external_file_id);

-- Реестры, загруженные в проверку (последний действует; прежние — для аудита)
CREATE TABLE registries (
  id             TEXT PRIMARY KEY,
  process_id     TEXT NOT NULL REFERENCES processes(id),
  original_name  TEXT,
  format         TEXT NOT NULL,        -- CSV | XLSX | JSON
  file_path      TEXT,                 -- исходный файл в хранилище (для JSON из формы — нормализованная копия)
  sha256         TEXT,
  entries        TEXT NOT NULL,        -- JSON UploadManifest после разбора
  entries_total  INTEGER NOT NULL,
  created_by     TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_registries_process ON registries(process_id, created_at);

UPDATE evidence_fragments SET approval_status = 'DRAFT' WHERE approval_status = 'NOT_APPROVED';
UPDATE checks SET completeness_status = 'MISSING_EVIDENCE' WHERE completeness_status IN ('PARTIAL', 'MISSING');
UPDATE dataset_items SET split = 'HIDDEN_TEST' WHERE split = 'TEST';
