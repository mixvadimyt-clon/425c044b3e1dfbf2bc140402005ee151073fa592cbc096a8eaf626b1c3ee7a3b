// Пакет документов для мока из папки комплекта:
//   npm run package -- <папка> [--id ID] [--object-id ALT79B] [--name "ЖК …"] [--address "…"] [--title "…"]
// Файлы не копируются — в пакете символические ссылки (датасет большой). Реестр (registry.csv, document_manifest.jsonl…)
// кладите в корень папки: мок отдаст его отдельным полем registry.
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PACKAGE_META } from './server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    id: { type: 'string' },
    'object-id': { type: 'string' },
    name: { type: 'string' },
    address: { type: 'string' },
    title: { type: 'string' },
    out: { type: 'string', default: process.env.RIN_MOCK_PACKAGES_DIR || 'var/rin-mock/packages' },
  },
});
const source = positionals[0] && path.resolve(positionals[0]);
if (!source || !existsSync(source) || !statSync(source).isDirectory()) {
  console.error('Укажите папку комплекта: npm run package -- <папка> [--object-id ALT79B] [--name "…"]');
  process.exit(1);
}
const id = values.id ?? `PKG-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
const outRoot = path.isAbsolute(values.out) ? values.out : path.join(ROOT, values.out);
const target = path.join(outRoot, id);
if (existsSync(target)) {
  console.error(`Пакет ${id} уже есть: ${target}`);
  process.exit(1);
}
mkdirSync(target, { recursive: true });
for (const name of readdirSync(source)) {
  if (name.startsWith('.')) continue;
  try {
    symlinkSync(path.join(source, name), path.join(target, name));
  } catch {
    cpSync(path.join(source, name), path.join(target, name), { recursive: true });
  }
}
const objectId = values['object-id'] ?? path.basename(source);
writeFileSync(
  path.join(target, PACKAGE_META),
  JSON.stringify(
    {
      package_id: id,
      created_at: new Date().toISOString(),
      title: values.title ?? null,
      object: { object_id: objectId, name: values.name ?? path.basename(source), address: values.address ?? null },
    },
    null,
    2,
  ),
);
console.log(`Пакет ${id} (объект ${objectId}) → ${target}`);
