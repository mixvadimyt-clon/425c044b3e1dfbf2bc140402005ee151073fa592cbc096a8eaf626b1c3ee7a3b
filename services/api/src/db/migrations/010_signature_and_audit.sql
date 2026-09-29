-- Подвязка под ЭЦП: открепленная подпись хранится рядом с документом.
-- Проверки подписи нет и не заявляем: доступа к УКЭП на соревновании не дают (REQ-INT-02),
-- поэтому verification всегда NOT_VERIFIED, а signature_status файла берётся из реестра.
ALTER TABLE files ADD COLUMN signature_name        TEXT;
ALTER TABLE files ADD COLUMN signature_sha256      TEXT;
ALTER TABLE files ADD COLUMN signature_size_bytes  INTEGER;
ALTER TABLE files ADD COLUMN signature_uploaded_at TEXT;
ALTER TABLE files ADD COLUMN signature_uploaded_by TEXT;
