/**
 * Импорт комплекта из папки на сервере (без лимитов интерфейса) через API.
 *   npm run import:dir -- --list
 *   npm run import:dir -- --path "Алтуфьевское, 79Б" [--object-name "..."] [--external-id ALT-79B] [--registry реестр.xlsx | --manifest manifest.json] [--no-start]
 * Реестр файлов (CSV/XLSX/JSON) ищется в корне папки сам (registry.* / реестр* / manifest*); --registry — путь внутри папки.
 * Папки берутся из IMPORT_ROOT (по умолчанию dataset/ в корне репозитория); испорченные имена исправляются.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { fixMojibakeName } from '../modules/names.js';

const { values } = parseArgs({
  options: {
    path: { type: 'string' },
    'object-name': { type: 'string' },
    'external-id': { type: 'string' },
    'process-id': { type: 'string' },
    manifest: { type: 'string' },
    registry: { type: 'string' },
    'no-start': { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
    api: { type: 'string' },
    login: { type: 'string', default: 'inspector' },
    password: { type: 'string' },
  },
});

const config = loadConfig();
if (values.list || !values.path) {
  console.log(`Папки для импорта в ${config.importRoot}:`);
  for (const e of readdirSync(config.importRoot, { withFileTypes: true })) {
    if (e.isDirectory() && !e.name.startsWith('.')) console.log(`  • ${fixMojibakeName(e.name)}`);
  }
  if (!values.path) console.log('\nИмпорт: npm run import:dir -- --path "<папка>"');
  process.exit(0);
}

const api = values.api ?? `http://localhost:${config.port}`;
const post = async (url: string, body: unknown, token?: string) => {
  const res = await fetch(`${api}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) throw new Error(`${res.status} ${json.message ?? ''} ${json.details ? JSON.stringify(json.details) : ''}`);
  return json;
};

try {
  const { access_token } = await post('/api/v1/auth/login', { login: values.login, password: values.password ?? values.login });
  const started = Date.now();
  const r = await post(
    '/api/v1/documents/import',
    {
      path: values.path,
      object_name: values['object-name'],
      external_id: values['external-id'],
      process_id: values['process-id'],
      manifest: values.manifest ? JSON.parse(readFileSync(values.manifest, 'utf8')) : undefined,
      registry_path: values.registry,
      auto_start: !values['no-start'],
    },
    access_token,
  );
  const files = r.files as { status: string; original_name: string; error?: { code: string } | null; warnings?: { code: string }[] }[];
  const rejected = files.filter((f) => f.status === 'REJECTED');
  console.log(`Проверка ${r.process_id}: принято ${files.length - rejected.length}, отклонено ${rejected.length} за ${((Date.now() - started) / 1000).toFixed(1)} с`);
  console.log(`Статусы загрузки: ${(r.upload_status as string[]).join(', ')}; статус проверки: ${r.process_status}`);
  for (const f of rejected) console.log(`  ✗ ${f.original_name} — ${f.error?.code}`);
  for (const f of files.filter((x) => x.warnings?.length)) console.log(`  ! ${f.original_name} — ${f.warnings!.map((w) => w.code).join(', ')}`);
} catch (err) {
  console.error(`Импорт не выполнен: ${(err as Error).message}. Запущен ли api (${api})?`);
  process.exit(1);
}
