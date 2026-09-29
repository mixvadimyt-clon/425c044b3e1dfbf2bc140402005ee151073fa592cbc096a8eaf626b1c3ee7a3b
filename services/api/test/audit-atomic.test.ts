/**
 * Журнал до действия: изменение без строки в журнале невозможно.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, makeTestApp } from './helpers.js';

type Json = Record<string, any>;

describe('аудит атомарно с действием', () => {
  let t: Awaited<ReturnType<typeof makeTestApp>>;
  let inspector: Record<string, string>;
  let supervisor: Record<string, string>;

  beforeAll(async () => {
    t = await makeTestApp();
    inspector = await login(t.app, 'inspector');
    supervisor = await login(t.app, 'supervisor');
  });
  afterAll(() => t.cleanup());

  const auditOf = async (action: string) =>
    ((await t.app.inject({ url: `/api/v1/audit?page_size=200`, headers: supervisor })).json().items as Json[]).filter((a) => a.action === action);

  it('журнал не записался — действие не выполнено', async () => {
    const before = t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM objects')!.n;
    const insert = t.ctx.db.insert.bind(t.ctx.db);
    let failed = false;
    t.ctx.db.insert = ((table: string, row: Parameters<typeof insert>[1]) => {
      if (table === 'audit_log' && !failed) {
        failed = true;
        throw new Error('диск полон');
      }
      return insert(table, row);
    }) as typeof t.ctx.db.insert;
    try {
      const res = await t.app.inject({ method: 'POST', url: '/api/v1/objects', headers: inspector, payload: { name: 'Без журнала' } });
      expect(res.statusCode).toBe(500);
    } finally {
      t.ctx.db.insert = insert;
    }
    expect(failed).toBe(true);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM objects')!.n).toBe(before);
  });

  it('обычное действие — одна строка журнала с итогом, без пометки «начато»', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/objects', headers: inspector, payload: { name: 'С журналом' } });
    expect(res.statusCode).toBe(201);
    const rows = (await auditOf('createObject')).filter((a) => a.details?.status_code === 201);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_role: 'INSPECTOR' });
    expect(rows[0].details.state).toBeUndefined();
  });

  it('отказ до обработчика (нет токена) тоже в журнале, как раньше', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/objects', payload: { name: 'Без входа' } });
    expect(res.statusCode).toBe(401);
    expect((await auditOf('createObject')).some((a) => a.details?.status_code === 401)).toBe(true);
  });
});
