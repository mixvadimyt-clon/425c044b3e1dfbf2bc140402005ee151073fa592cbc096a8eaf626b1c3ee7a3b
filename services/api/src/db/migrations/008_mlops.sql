-- ML-контур (REQ-ML-01…06): воспроизводимые версии GOLD-набора и реестр моделей с журналом решений.

-- снимок GOLD-записи на момент выпуска: выгрузка версии и её хеши не зависят от последующих правок
ALTER TABLE dataset_items ADD COLUMN record TEXT;
CREATE INDEX idx_dataset_items_version ON dataset_items(dataset_version);

ALTER TABLE dataset_versions ADD COLUMN split_counts TEXT NOT NULL DEFAULT '{}';
ALTER TABLE dataset_versions ADD COLUMN objects_by_split TEXT NOT NULL DEFAULT '{}';
ALTER TABLE dataset_versions ADD COLUMN new_items INTEGER NOT NULL DEFAULT 0;

ALTER TABLE model_versions ADD COLUMN code_version TEXT;
ALTER TABLE model_versions ADD COLUMN split_hashes TEXT NOT NULL DEFAULT '{}';
ALTER TABLE model_versions ADD COLUMN threshold_checks TEXT NOT NULL DEFAULT '[]';
ALTER TABLE model_versions ADD COLUMN registered_by TEXT;
ALTER TABLE model_versions ADD COLUMN decided_at TEXT;
ALTER TABLE model_versions ADD COLUMN comment TEXT;

-- журнал итераций (REQ-ML-05): регистрация и каждое решение
ALTER TABLE ml_retraining_log ADD COLUMN action TEXT;    -- REGISTER | APPROVE | REJECT | ROLLBACK
ALTER TABLE ml_retraining_log ADD COLUMN comment TEXT;
ALTER TABLE ml_retraining_log ADD COLUMN details TEXT;   -- JSON: проверки, артефакт, параметры обучения
