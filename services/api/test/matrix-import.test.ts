import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { Db } from '../src/db/sqlite.js';
import { importMatrix } from '../src/modules/matrix-import.js';

const HEADER =
  'code,external_code,section,parameter_name,unit,source_pd,source_rd,source_id,trigger_logic,review_priority,' +
  'sp_reference,gost_reference,fz_reference,other_normative,data_type,min_value,max_value,regex_pattern,' +
  'semantic_anchors,enum_values,is_active';

/** Строка матрицы: только то, что важно тесту, остальное — пусто, как в настоящем файле. */
function row(
  code: string,
  { name = `Параметр ${code}`, section = 'ПЗ', type = 'number', priority = 'HIGH', active = 'false', extra = {} as Record<string, string> } = {},
): string {
  const cells: Record<string, string> = {
    code,
    section,
    parameter_name: name,
    review_priority: priority,
    data_type: type,
    is_active: active,
    ...extra,
  };
  return HEADER.split(',')
    .map((field) => cells[field] ?? '')
    .join(',');
}

const csv = (...rows: string[]): string => [HEADER, ...rows].join('\n') + '\n';

function freshDb(): Db {
  const db = new Db(':memory:');
  db.migrate();
  return db;
}

const activeCodes = (db: Db): string[] =>
  db.all<{ code: string }>('SELECT code FROM params WHERE is_active = 1 ORDER BY code').map((r) => r.code);

describe('импорт матрицы в работающую базу', () => {
  let db: Db;

  beforeEach(() => {
    db = freshDb();
    // Первичное заполнение, как в сиде: активны ровно M-002 и M-055
    importMatrix(db, csv(row('M-002'), row('M-055', { type: 'enum', extra: { enum_values: 'B25|B30' } })), {
      initialActive: ['M-002', 'M-055'],
    });
  });

  it('первичный импорт включает ровно указанные коды', () => {
    expect(activeCodes(db)).toEqual(['M-002', 'M-055']);
  });

  it('повторный импорт того же файла не трогает активность', () => {
    // В файле организаторов у всех параметров is_active=false: если брать активность оттуда,
    // импорт во время экспертизы молча выключил бы оба рабочих параметра
    const report = importMatrix(db, csv(row('M-002'), row('M-055', { type: 'enum', extra: { enum_values: 'B25|B30' } })), {});
    expect(activeCodes(db)).toEqual(['M-002', 'M-055']);
    expect(report.deactivated).toEqual([]);
    expect(report.unchanged).toHaveLength(2);
    expect(report.applied).toBe(false); // менять нечего — и версию не плодим
  });

  it('новый параметр приходит выключенным, пока его не включили явно', () => {
    const report = importMatrix(db, csv(row('M-002'), row('M-055'), row('M-010')), { snapshot: null });
    expect(report.added).toEqual(['M-010']);
    expect(activeCodes(db)).toEqual(['M-002', 'M-055']);

    importMatrix(db, csv(row('M-002'), row('M-055'), row('M-010')), { activate: ['M-010'] });
    expect(activeCodes(db)).toEqual(['M-002', 'M-010', 'M-055']);
  });

  it('--activate all включает все параметры файла, а всё уже включённое остаётся', () => {
    const report = importMatrix(db, csv(row('M-002'), row('M-055'), row('M-010')), { activate: ['all'] });
    expect(report.errors).toEqual([]);
    expect(report.activated).toEqual(['M-010']);
    expect(activeCodes(db)).toEqual(['M-002', 'M-010', 'M-055']);
  });

  it('первичный импорт с ALL (MATRIX_ACTIVE_PARAMS=all) включает всю матрицу', () => {
    const empty = freshDb();
    importMatrix(empty, csv(row('M-001'), row('M-002')), { initialActive: ['all'] });
    expect(activeCodes(empty)).toEqual(['M-001', 'M-002']);
  });

  it('--deactivate выключает параметр и это видно в отчёте', () => {
    const report = importMatrix(db, csv(row('M-002'), row('M-055')), { deactivate: ['M-002'] });
    expect(report.deactivated).toEqual(['M-002']);
    expect(activeCodes(db)).toEqual(['M-055']);
  });

  it('изменение поля видно как правка, дата правки нетронутых не меняется', () => {
    const before = db.get<{ updated_at: string }>("SELECT updated_at FROM params WHERE code = 'M-055'")!.updated_at;
    const report = importMatrix(db, csv(row('M-002', { name: 'Общая площадь здания' }), row('M-055', { type: 'enum', extra: { enum_values: 'B25|B30' } })), {});
    expect(report.updated).toEqual(['M-002']);
    expect(report.unchanged).toEqual(['M-055']);
    expect(db.get<{ updated_at: string }>("SELECT updated_at FROM params WHERE code = 'M-055'")!.updated_at).toBe(before);
  });

  it('ошибка в файле — не записано ничего', () => {
    const report = importMatrix(db, csv(row('M-002', { name: 'Новое имя' }), row('M-777', { priority: 'СРОЧНО' })), {});
    expect(report.applied).toBe(false);
    expect(report.errors.map((e) => e.code)).toEqual(['M-777']);
    expect(report.errors[0].row).toBe(3);
    expect(db.get<{ parameter_name: string }>("SELECT parameter_name FROM params WHERE code = 'M-002'")!.parameter_name).toBe('Параметр M-002');
  });

  it.each([
    ['код не по формату', csv(row('X-1')), 'формату'],
    ['повтор кода в файле', csv(row('M-002'), row('M-002')), 'повторяется'],
    ['пустое наименование', csv(row('M-003', { name: '' })), 'наименование'],
    ['нечисловой предел', csv(row('M-003', { extra: { min_value: 'много' } })), 'не число'],
    ['min больше max', csv(row('M-003', { extra: { min_value: '10', max_value: '1' } })), 'больше'],
    ['неизвестный тип данных', csv(row('M-003', { type: 'таблица' })), 'тип данных'],
  ])('отбивает файл: %s', (_name, text, message) => {
    const report = importMatrix(db, text, {});
    expect(report.applied).toBe(false);
    expect(report.errors.map((e) => e.message).join(' ')).toContain(message);
  });

  it('код из --activate, которого нет ни в файле, ни в базе — ошибка', () => {
    const report = importMatrix(db, csv(row('M-002'), row('M-055')), { activate: ['M-999'] });
    expect(report.applied).toBe(false);
    expect(report.errors[0].message).toContain('нет ни в файле, ни в базе');
  });

  it('параметр, которого нет в файле, остаётся в базе и работает', () => {
    const report = importMatrix(db, csv(row('M-002')), {});
    expect(report.absent).toEqual(['M-055']);
    expect(activeCodes(db)).toContain('M-055');
  });

  it('dry-run считает, но не пишет', () => {
    const report = importMatrix(db, csv(row('M-002'), row('M-055'), row('M-010')), { dryRun: true, activate: ['M-010'] });
    expect(report.added).toEqual(['M-010']);
    expect(report.activated).toEqual(['M-010']);
    expect(report.applied).toBe(false);
    expect(db.get('SELECT 1 FROM params WHERE code = ?', 'M-010')).toBeUndefined();
  });

  it('версия матрицы создаётся в той же транзакции и только при изменениях', () => {
    const none = importMatrix(db, csv(row('M-002'), row('M-055', { type: 'enum', extra: { enum_values: 'B25|B30' } })), {
      snapshot: { comment: 'ничего не менялось', userId: null },
    });
    expect(none.version).toBeNull();
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM matrix_versions')!.n).toBe(0);

    const added = importMatrix(db, csv(row('M-002'), row('M-055'), row('M-010')), {
      snapshot: { comment: 'добавлен M-010', userId: null },
    });
    expect(added.version).toBe('m-0.1');
    const snapshot = db.get<{ params_snapshot: string; params_count: number }>('SELECT * FROM matrix_versions')!;
    expect(snapshot.params_count).toBe(2); // в снимке считаются только активные
    expect(JSON.parse(snapshot.params_snapshot)).toHaveLength(3);
  });

  it('точка с запятой как разделитель (выгрузка Excel) читается тоже', () => {
    const semicolon = csv(row('M-002'), row('M-010')).replace(/,/g, ';');
    const report = importMatrix(db, semicolon, {});
    expect(report.added).toEqual(['M-010']);
  });
});

describe('настоящая матрица проекта', () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../data/matrix/params.csv');

  it('импортируется без ошибок, все 132 параметра', () => {
    const db = freshDb();
    const report = importMatrix(db, readFileSync(file, 'utf8'), { activate: ['M-002', 'M-055'] });
    expect(report.errors).toEqual([]);
    expect(report.total).toBe(132);
    expect(report.added).toHaveLength(132);
    expect(activeCodes(db)).toEqual(['M-002', 'M-055']);
  });

  it('шаблоны с питоновским `(?i)` проходят как замечание, а не как ошибка', () => {
    const db = freshDb();
    const report = importMatrix(db, readFileSync(file, 'utf8'), {});
    // Шаблоны исполняет ML на Python, поэтому JS-несовместимый синтаксис не повод отбить матрицу
    expect(report.errors).toEqual([]);
    expect(report.warnings.every((w) => /enum|regex_pattern/.test(w.message))).toBe(true);
  });
});
