import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { hashPassword } from '../auth/passwords.js';
import type { AppConfig } from '../config.js';
import { snapshotMatrix } from '../modules/matrix.js';
import { importMatrix } from '../modules/matrix-import.js';
import { type Db, nowIso } from './sqlite.js';

/** Демо-пользователи по ролям. Пароль — DEMO_PASSWORD (стенд), без него логин = пароль (разработка). */
export const DEMO_USERS = [
  { login: 'inspector', full_name: 'Иванов Иван (инспектор)', role: 'INSPECTOR' },
  { login: 'supervisor', full_name: 'Петрова Анна (супервизор)', role: 'SUPERVISOR' },
  { login: 'admin', full_name: 'Администратор системы', role: 'ADMIN' },
  { login: 'ml', full_name: 'ML-инженер', role: 'ML_ENGINEER' },
] as const;

/** Технический пользователь автозабора из внешней ИС: от его имени загружаются файлы пакетов. Войти под ним нельзя. */
export const INTEGRATION_LOGIN = 'integration';

/** Импорт матрицы из CSV (формат: docs/domain/matrix.md). Возвращает число строк в файле.
 *
 * Обёртка над `importMatrix` для первичного заполнения пустой базы: активны ровно `activeCodes`
 * (`null` — активность берётся из файла). Для работающей базы есть `npm run matrix:import`,
 * который активность не трогает.
 */
export function importMatrixCsv(db: Db, csvText: string, activeCodes: string[] | null): number {
  return importMatrix(db, csvText, { initialActive: activeCodes }).total;
}

/** Идемпотентный сид: пользователи, матрица (активны только initialActiveParams), первая версия матрицы. */
export async function seed(db: Db, config: AppConfig): Promise<void> {
  // Без DEMO_PASSWORD пароль демо-пользователя равен логину — для разработки это удобно, а для
  // сервера означает вход под admin/admin. NODE_ENV=production стоит в образе api, поэтому
  // стенд, поднятый мимо infra/stand/setup.sh (он пароль генерирует), просто не запустится.
  if (!config.demoPassword && process.env.NODE_ENV === 'production') {
    throw new Error(
      'DEMO_PASSWORD не задан: демо-пользователи получили бы пароль, равный логину. ' +
        'Задайте DEMO_PASSWORD в .env.stand: infra/stand/setup.sh делает это сам.',
    );
  }

  const now = nowIso();
  for (const u of DEMO_USERS) {
    if (db.get('SELECT 1 FROM users WHERE login = ?', u.login)) continue;
    db.insert('users', {
      id: randomUUID(),
      login: u.login,
      password_hash: await hashPassword(config.demoPassword || u.login),
      full_name: u.full_name,
      role: u.role,
      is_active: 1,
      created_at: now,
    });
  }

  if (!db.get('SELECT 1 FROM users WHERE login = ?', INTEGRATION_LOGIN)) {
    db.insert('users', {
      id: randomUUID(),
      login: INTEGRATION_LOGIN,
      password_hash: await hashPassword(randomUUID()),
      full_name: `${config.rin.systemName} (автозабор)`,
      role: 'INSPECTOR',
      is_active: 0,
      created_at: now,
    });
  }

  const hasParams = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM params')!.n > 0;
  if (!hasParams && existsSync(config.matrixCsv)) {
    importMatrixCsv(db, readFileSync(config.matrixCsv, 'utf8'), config.initialActiveParams);
  }
  if (!db.get('SELECT 1 FROM matrix_versions')) {
    snapshotMatrix(db, 'Начальная матрица: активны ' + config.initialActiveParams.join(', '), null, 'm-0.1');
  }
}
