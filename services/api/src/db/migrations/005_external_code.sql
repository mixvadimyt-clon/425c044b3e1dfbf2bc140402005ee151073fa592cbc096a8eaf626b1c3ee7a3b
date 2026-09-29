-- Код параметра у организаторов (каталог parameter_catalog_132: KR-055, IOS4-078…) — для выгрузки submission.
-- Для уже загруженной матрицы выводим его из раздела и номера, как data/matrix/build_params.py.
ALTER TABLE params ADD COLUMN external_code TEXT;
UPDATE params SET external_code = (
  CASE section
    WHEN 'ПЗ' THEN 'PZ' WHEN 'СПЗУ' THEN 'SPZU' WHEN 'АР' THEN 'AR' WHEN 'КР' THEN 'KR' WHEN 'ППМ' THEN 'PPM'
    WHEN 'ПОС' THEN 'POS' WHEN 'ОДИ' THEN 'ODI' WHEN 'ПОД' THEN 'POD' WHEN 'ЗУ' THEN 'ZU' WHEN 'ООС' THEN 'OOS'
    WHEN 'СМ' THEN 'SM' WHEN 'ИОС1' THEN 'IOS1' WHEN 'ИОС2' THEN 'IOS2' WHEN 'ИОС3' THEN 'IOS3'
    WHEN 'ИОС4' THEN 'IOS4' WHEN 'ИОС5' THEN 'IOS5'
  END
) || '-' || substr(code, 3)
WHERE code LIKE 'M-%';
