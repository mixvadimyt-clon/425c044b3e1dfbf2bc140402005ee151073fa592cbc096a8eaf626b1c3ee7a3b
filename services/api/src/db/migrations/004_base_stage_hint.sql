-- Стадия без учёта реестра (подсказка пользователя или папка импорта): к ней возвращаемся,
-- если файл выпал из нового реестра, чтобы он не потерял стадию.
ALTER TABLE files ADD COLUMN base_stage_hint TEXT;
UPDATE files SET base_stage_hint = stage_hint WHERE in_registry = 0;
