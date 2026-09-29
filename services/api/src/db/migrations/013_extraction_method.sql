-- Как найдено значение фрагмента: RULES | SBERT (контракт 0.23.0).
-- NULL — правила: протоколы до 0.23.0 и области, указанные инспектором вручную.
ALTER TABLE evidence_fragments ADD COLUMN extraction_method TEXT;
