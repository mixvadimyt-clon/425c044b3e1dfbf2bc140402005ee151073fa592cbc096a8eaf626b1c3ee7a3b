/**
 * Импорт матрицы параметров в работающую базу. Без пересоздания базы, в отличие от `db:reset`.
 *
 *   npm run matrix:import                                   # показать, что изменится (ничего не пишет)
 *   npm run matrix:import -- --apply
 *   npm run matrix:import -- --file новая-матрица.csv --apply
 *   npm run matrix:import -- --activate M-010,M-011 --apply
 *   npm run matrix:import -- --activate all --apply          # все параметры файла
 *   npm run matrix:import -- --deactivate M-002 --apply
 *
 * По умолчанию только считает и печатает план: матрицу правят на работающем стенде, и «сначала
 * посмотреть» здесь важнее краткости — так же, как у `infra/stand/yc-stand.sh`.
 *
 * **Активность сама не меняется.** Файл организаторов приходит со всеми `is_active=false`, и если
 * брать активность из него, импорт во время экспертизы выключил бы M-002 и M-055. Новые параметры
 * приходят выключенными; включать — только явным `--activate`.
 *
 * На стенде api перезапускать не нужно: матрицу он читает из базы при каждом запуске сравнения
 * (`orchestrator`), а не держит в памяти.
 *   docker compose -f docker-compose.app.yml --env-file .env.stand exec api \
 *     node --disable-warning=ExperimentalWarning dist/cli/matrix-import.js --apply
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { Db } from '../db/sqlite.js';
import { ALL_PARAMS, importMatrix, type MatrixIssue } from '../modules/matrix-import.js';

const { values } = parseArgs({
  options: {
    file: { type: 'string' },
    activate: { type: 'string' },
    deactivate: { type: 'string' },
    comment: { type: 'string' },
    apply: { type: 'boolean', default: false },
  },
});

const asCodes = (v: string | undefined): string[] =>
  (v ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const shown = (codes: string[]): string => (codes.includes(ALL_PARAMS) ? 'все параметры файла' : codes.join(', '));

const config = loadConfig();
const file = values.file ? path.resolve(values.file) : config.matrixCsv;
if (!existsSync(file)) {
  console.error(`Нет файла матрицы: ${file}`);
  process.exit(1);
}

const list = (items: string[], limit = 12): string =>
  items.length <= limit ? items.join(', ') : `${items.slice(0, limit).join(', ')} … и ещё ${items.length - limit}`;
const issues = (title: string, items: MatrixIssue[]): void => {
  if (items.length === 0) return;
  console.log(`\n${title}:`);
  for (const i of items) console.log(`  ${i.row ? `строка ${i.row}, ` : ''}${i.code}: ${i.message}`);
};

const fresh = !existsSync(config.dbPath);
const db = new Db(config.dbPath);
db.migrate();
let failed = false;
try {
  const activate = asCodes(values.activate);
  const deactivate = asCodes(values.deactivate);
  const dryRun = !values.apply;
  const report = importMatrix(db, readFileSync(file, 'utf8'), {
    activate,
    deactivate,
    dryRun,
    snapshot: {
      comment:
        values.comment ??
        `Импорт матрицы из ${path.basename(file)}${activate.length ? `; включены ${shown(activate)}` : ''}${
          deactivate.length ? `; выключены ${shown(deactivate)}` : ''
        }`,
      userId: null,
    },
  });

  console.log(`Файл: ${file}`);
  console.log(`База: ${config.dbPath}`);
  console.log(`Строк в файле: ${report.total}`);
  console.log(`  новых:       ${report.added.length}${report.added.length ? ` — ${list(report.added)}` : ''}`);
  console.log(`  изменённых:  ${report.updated.length}${report.updated.length ? ` — ${list(report.updated)}` : ''}`);
  console.log(`  без правок:  ${report.unchanged.length}`);
  if (report.activated.length) console.log(`  включены:    ${list(report.activated)}`);
  if (report.deactivated.length) console.log(`  выключены:   ${list(report.deactivated)}`);
  if (report.absent.length) console.log(`  нет в файле, оставлены в базе: ${report.absent.length} — ${list(report.absent)}`);

  issues('Замечания (импорту не мешают)', report.warnings);
  issues('Ошибки — не изменено ничего', report.errors);

  if (report.errors.length > 0) {
    console.error('\nИмпорт не выполнен: исправьте файл и повторите.');
    failed = true;
  } else if (report.applied) {
    console.log(`\nГотово. Версия матрицы: ${report.version}. Перезапуск api не нужен — она читается при каждом сравнении.`);
  } else if (dryRun) {
    console.log('\nЭто был только план. Чтобы применить: npm run matrix:import -- --apply');
  } else {
    console.log('\nИзменений нет — база уже соответствует файлу, новая версия не создавалась.');
  }
  if (fresh && activate.length === 0) {
    const verb = report.applied ? 'импортированы' : 'будут импортированы';
    console.log(`База была пустой: параметры ${verb} выключенными. Включить — --activate all (или список кодов)`);
  }
} finally {
  db.close();
}
// Закрываем базу до выхода: process.exit не выполняет finally
if (failed) process.exit(1);
