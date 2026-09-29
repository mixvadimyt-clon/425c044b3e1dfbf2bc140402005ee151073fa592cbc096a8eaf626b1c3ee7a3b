-- Кто загрузил файл и заголовок документа (из реестра). Сам файл лежит в хранилище по ключу raw/{sha256}
-- (files.file_path) — в БД только ссылка и метаданные.
ALTER TABLE files ADD COLUMN uploaded_by TEXT;
ALTER TABLE files ADD COLUMN title TEXT;
UPDATE files SET uploaded_by = (SELECT created_by FROM processes p WHERE p.id = files.process_id) WHERE uploaded_by IS NULL;
CREATE INDEX idx_audit_actor ON audit_log(user_id, timestamp);
