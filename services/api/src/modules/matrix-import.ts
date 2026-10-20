/**
 * Импорт матрицы параметров из CSV. Формат — [docs/domain/matrix.md](../../../../docs/domain/matrix.md).
 *
 * Отличие от первичного сида в том, что база **работающая**: в ней уже идут проверки, у параметров
 * выбрана активность, а на неё завязано всё сравнение. Поэтому:
 *
 * - **активность по умолчанию не трогаем.** Файл организаторов приходит со всеми `is_active=false`,
 *   и если брать её из CSV, повторный импорт во время экспертизы выключил бы M-002 и M-055 —
 *   протоколы стали бы пустыми. Менять активность можно только явно: `activate` / `deactivate`;
 * - **новый параметр приходит выключенным.** Матрица растёт до 132 параметров, и включать их
 *   молча нельзя: каждый включённый параметр это новые кандидаты в работе у инспектора;
 * - **всё или ничего.** Ошибка хотя бы в одной строке — не пишем ничего: половина матрицы хуже,
 *   чем старая матрица целиком;
 * - **версия матрицы** создаётся в той же транзакции, иначе снимок разъедется с параметрами.
 *
 * Параметры, которых нет в CSV, остаются в базе нетронутыми: на них могут ссылаться готовые
 * протоколы, а «пропал из файла» не то же самое, что «отменён».
 */
import { type Db, nowIso } from '../db/sqlite.js';
import { snapshotMatrix } from './matrix.js';
import { detectDelimiter, parseCsv } from './tabular.js';

const PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'];
const DATA_TYPES = ['number', 'string', 'boolean', 'coordinate', 'enum'];
const CODE = /^M-\d{3}$/;
/** Встроенные флаги Python (`(?i)`, `(?is)`) — в JS их нет, но шаблоны исполняет ML на Python. */
const INLINE_FLAGS = /^\(\?[imsxa]+\)/;

export interface MatrixIssue {
  /** Номер строки в файле вместе с заголовком — как покажет редактор таблиц. */
  row: number;
  code: string;
  message: string;
}

export interface MatrixImportReport {
  total: number;
  added: string[];
  updated: string[];
  unchanged: string[];
  activated: string[];
  deactivated: string[];
  /** Есть в базе, но нет в файле — оставлены как есть. */
  absent: string[];
  errors: MatrixIssue[];
  warnings: MatrixIssue[];
  /** Новая версия матрицы, если что-то изменилось и импорт применён. */
  version: string | null;
  applied: boolean;
}

/** Вместо списка кодов — все параметры файла: `--activate all`, `MATRIX_ACTIVE_PARAMS=all`. */
export const ALL_PARAMS = 'ALL';

export interface MatrixImportOptions {
  /** Включить эти коды (`ALL` — все из файла); остальных активность не касается. */
  activate?: string[];
  /** Выключить эти коды (`ALL` — все из файла). */
  deactivate?: string[];
  /**
   * Первичный импорт в пустую базу (сид): активны ровно эти коды (`ALL` — все), `null` — брать
   * `is_active` из CSV. Для работающей базы не используется.
   */
  initialActive?: string[] | null;
  /** Посчитать и показать, но ничего не писать. */
  dryRun?: boolean;
  /** Создать версию матрицы в той же транзакции. */
  snapshot?: { comment: string; userId: string | null } | null;
}

type Value = string | number | null;
type Values = Record<string, Value>;

const orNull = (v: string | undefined): string | null => (v === undefined || v.trim() === '' ? null : v.trim());
const list = (v: string | undefined): string[] => (v ? v.split('|').map((s) => s.trim()).filter(Boolean) : []);

function num(v: string | undefined): number | null {
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v.trim().replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}

/** Поля параметра из строки CSV — ровно те, что лежат в таблице `params` (без `code` и дат). */
function toValues(r: Record<string, string>): Values {
  return {
    external_code: orNull(r.external_code),
    section: (r.section ?? '').trim(),
    parameter_name: (r.parameter_name ?? '').trim(),
    unit: orNull(r.unit),
    source_pd: orNull(r.source_pd),
    source_rd: orNull(r.source_rd),
    source_id: orNull(r.source_id),
    trigger_logic: orNull(r.trigger_logic),
    review_priority: (r.review_priority ?? '').trim() || 'MEDIUM',
    sp_reference: orNull(r.sp_reference),
    gost_reference: orNull(r.gost_reference),
    fz_reference: orNull(r.fz_reference),
    other_normative: orNull(r.other_normative),
    data_type: (r.data_type ?? '').trim() || 'string',
    min_value: num(r.min_value),
    max_value: num(r.max_value),
    regex_pattern: orNull(r.regex_pattern),
    semantic_anchors: JSON.stringify(list(r.semantic_anchors)),
    enum_values: JSON.stringify(list(r.enum_values)),
  };
}

function check(row: number, code: string, values: Values, raw: Record<string, string>, report: MatrixImportReport): void {
  const err = (message: string) => report.errors.push({ row, code, message });
  const warn = (message: string) => report.warnings.push({ row, code, message });

  if (!CODE.test(code)) err(`код «${code}» не по формату M-001…M-132`);
  if (!values.section) err('пустой раздел (section)');
  if (!values.parameter_name) err('пустое наименование параметра (parameter_name)');
  if (!PRIORITIES.includes(values.review_priority as string)) {
    err(`приоритет «${values.review_priority}»: допустимы ${PRIORITIES.join(', ')}`);
  }
  if (!DATA_TYPES.includes(values.data_type as string)) {
    err(`тип данных «${values.data_type}»: допустимы ${DATA_TYPES.join(', ')}`);
  }
  for (const field of ['min_value', 'max_value'] as const) {
    if (Number.isNaN(values[field])) err(`${field}: «${raw[field]}» не число`);
  }
  const [min, max] = [values.min_value, values.max_value];
  if (typeof min === 'number' && typeof max === 'number' && !Number.isNaN(min) && !Number.isNaN(max) && min > max) {
    err(`min_value ${min} больше max_value ${max}`);
  }
  if (values.data_type === 'enum' && values.enum_values === '[]') {
    warn('тип enum без enum_values: сравнение по списку значений работать не будет');
  }
  if (typeof values.regex_pattern === 'string') {
    try {
      new RegExp(values.regex_pattern.replace(INLINE_FLAGS, ''));
    } catch {
      // Шаблон исполняет ML на Python, где синтаксис шире, поэтому это замечание, а не ошибка
      warn('шаблон regex_pattern не разбирается движком JS, проверьте его на стороне ML');
    }
  }
}

/** Значения совпадают с тем, что уже в базе (`NaN` сюда не доходит — такие строки отсеяны). */
function same(existing: Record<string, unknown>, values: Values): boolean {
  return Object.entries(values).every(([key, value]) => {
    const current = existing[key] ?? null;
    if (value === null || current === null) return value === current;
    if (typeof value === 'number') return Number(current) === value;
    return String(current) === value;
  });
}

/**
 * Импорт матрицы в работающую базу. При ошибках в файле не пишет ничего и возвращает отчёт
 * с `applied: false`.
 */
export function importMatrix(db: Db, csvText: string, options: MatrixImportOptions = {}): MatrixImportReport {
  const rows = parseCsv(csvText, detectDelimiter(csvText));
  const report: MatrixImportReport = {
    total: 0,
    added: [],
    updated: [],
    unchanged: [],
    activated: [],
    deactivated: [],
    absent: [],
    errors: [],
    warnings: [],
    version: null,
    applied: false,
  };

  const parsed: { code: string; values: Values; csvActive: boolean }[] = [];
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    const code = (r.code ?? '').trim();
    if (!code) return; // пустая строка в конце файла — не ошибка
    const row = i + 2; // +1 заголовок, +1 нумерация с единицы
    if (seen.has(code)) {
      report.errors.push({ row, code, message: 'код повторяется в файле' });
      return;
    }
    seen.add(code);
    const values = toValues(r);
    check(row, code, values, r, report);
    parsed.push({ code, values, csvActive: (r.is_active ?? '').trim() !== 'false' });
  });
  report.total = parsed.length;

  const codes = (list: string[] | undefined): Set<string> =>
    new Set((list ?? []).flatMap((c) => (c.toUpperCase() === ALL_PARAMS ? parsed.map((p) => p.code) : [c])));
  const activate = codes(options.activate);
  const deactivate = codes(options.deactivate);
  for (const code of [...activate].filter((c) => deactivate.has(c))) {
    report.errors.push({ row: 0, code, message: 'указан и в --activate, и в --deactivate' });
  }
  const initialActive = options.initialActive ? codes(options.initialActive) : options.initialActive;

  const existing = new Map(
    db.all<Record<string, unknown>>('SELECT * FROM params').map((r) => [r.code as string, r]),
  );
  report.absent = [...existing.keys()].filter((c) => !seen.has(c)).sort();
  for (const code of [...activate, ...deactivate]) {
    if (!seen.has(code) && !existing.has(code)) {
      report.errors.push({ row: 0, code, message: 'такого параметра нет ни в файле, ни в базе' });
    }
  }

  // Активность: у существующего параметра сохраняем, у нового выключаем — если явно не сказано иное
  const activeOf = (code: string, csvActive: boolean): boolean => {
    if (activate.has(code)) return true;
    if (deactivate.has(code)) return false;
    if (initialActive !== undefined && !existing.has(code)) {
      return initialActive === null ? csvActive : initialActive.has(code);
    }
    const prev = existing.get(code);
    return prev ? prev.is_active === 1 : false;
  };

  for (const { code, values } of parsed) {
    const prev = existing.get(code);
    if (!prev) report.added.push(code);
    else if (same(prev, values)) report.unchanged.push(code);
    else report.updated.push(code);
  }
  for (const [code, prev] of existing) {
    const wasActive = prev.is_active === 1;
    if (activate.has(code) && !wasActive) report.activated.push(code);
    if (deactivate.has(code) && wasActive) report.deactivated.push(code);
  }
  for (const { code } of parsed) {
    if (!existing.has(code) && activate.has(code)) report.activated.push(code);
  }

  const changed = report.added.length + report.updated.length + report.activated.length + report.deactivated.length;
  if (report.errors.length > 0 || options.dryRun || changed === 0) return report;

  const now = nowIso();
  const unchanged = new Set(report.unchanged);
  db.tx(() => {
    for (const { code, values, csvActive } of parsed) {
      const prev = existing.get(code);
      const active = activeOf(code, csvActive) ? 1 : 0;
      // Нетронутые параметры не переписываем: иначе у всех 132 обновится дата правки,
      // и в администрировании матрицы нельзя будет понять, что менялось на самом деле
      if (prev && unchanged.has(code) && prev.is_active === active) continue;
      const row = { ...values, is_active: active, updated_at: now };
      if (prev) db.update('params', row, 'id = ?', prev.id as number);
      else db.insert('params', { code, ...row, created_at: now });
    }
    // Параметр могли выключить, даже если его нет в файле: он всё ещё живёт в базе
    for (const code of report.absent) {
      if (!activate.has(code) && !deactivate.has(code)) continue;
      db.update('params', { is_active: activate.has(code) ? 1 : 0, updated_at: now }, 'code = ?', code);
    }
    if (options.snapshot) {
      report.version = snapshotMatrix(db, options.snapshot.comment, options.snapshot.userId);
    }
  });
  report.applied = true;
  return report;
}
