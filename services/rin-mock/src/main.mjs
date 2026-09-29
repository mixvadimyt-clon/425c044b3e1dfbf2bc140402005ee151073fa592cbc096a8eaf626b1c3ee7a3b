// Запуск мока внешней ИС: npm start (порт RIN_MOCK_PORT, по умолчанию 4020).
// Токен и секрет подписи — те же переменные, что у api (RIN_TOKEN, RIN_SECRET), из общего .env в корне.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRinMock } from './server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = (name, def = '') => process.env[name]?.trim() || def;
const resolve = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));

const opts = {
  packagesDir: resolve(env('RIN_MOCK_PACKAGES_DIR', 'var/rin-mock/packages')),
  resultsDir: resolve(env('RIN_MOCK_RESULTS_DIR', 'var/rin-mock/results')),
  token: env('RIN_TOKEN'),
  secret: env('RIN_SECRET'),
  systemName: env('RIN_SYSTEM_NAME', 'ИАИС «РиН»'),
};
const mock = createRinMock(opts);
// RIN_MOCK_FAIL=error:2 — первые две отправки результата получат 503 (демо повторов)
for (const item of env('RIN_MOCK_FAIL').split(',').filter(Boolean)) {
  const [mode, count] = item.split(':');
  mock.state.failNext(mode, Number(count ?? 1));
}
const url = await mock.listen(Number(env('RIN_MOCK_PORT', '4020')), env('RIN_MOCK_HOST', '127.0.0.1'));
console.log(`${opts.systemName} (мок) слушает ${url}`);
console.log(`  пакеты:     ${opts.packagesDir}`);
console.log(`  результаты: ${opts.resultsDir}`);
console.log(`  токен: ${opts.token ? 'проверяется' : 'не задан'} · подпись: ${opts.secret ? 'проверяется' : 'не задана'}`);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => mock.close().then(() => process.exit(0)));
