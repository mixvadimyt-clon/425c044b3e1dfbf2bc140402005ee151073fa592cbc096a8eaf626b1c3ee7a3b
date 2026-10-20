-- Сравнение с эталоном по каждой стадии (контракт 0.17.0): когда сравнивались
-- и РД, и ИД, у каждой своё значение, дельта и вывод. JSON-массив StageComparison; у протоколов
-- до миграции — пусто.
ALTER TABLE checks ADD COLUMN stage_comparisons TEXT NOT NULL DEFAULT '[]';
