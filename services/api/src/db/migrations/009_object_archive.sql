-- Архивирование объектов (снаружи выглядит как удаление) и роль в журнале действий.
-- Убирать объект насовсем нельзя: финализированный протокол мог уже уехать во внешнюю ИС,
-- и стирать то, на что есть квитанция, мы не вправе. Поэтому объект прячется из списка,
-- а проверки, протоколы, журнал и записи GOLD-набора остаются на месте.
ALTER TABLE objects ADD COLUMN created_by  TEXT;  -- кто создал: инспектор убирает только свои
ALTER TABLE objects ADD COLUMN archived_at TEXT;  -- NULL — объект в работе
ALTER TABLE objects ADD COLUMN archived_by TEXT;
CREATE INDEX idx_objects_archived ON objects(archived_at);

-- Роль на момент действия: она могла измениться позже, а журнал должен показывать тогдашнюю.
ALTER TABLE audit_log ADD COLUMN user_role TEXT;
