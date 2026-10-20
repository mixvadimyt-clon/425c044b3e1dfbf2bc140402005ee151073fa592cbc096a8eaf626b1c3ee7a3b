/**
 * Открытый вход на время экспертизы (OPEN_ACCESS, 29.09): организаторы попросили открыть стенд без пароля.
 * Без флага всё как раньше — вход только по паролю, список учётных записей наружу не отдаётся.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { telegramText } from '../src/modules/notify.js';
import { makeTestApp } from './helpers.js';

describe('без флага OPEN_ACCESS', () => {
  let t: Awaited<ReturnType<typeof makeTestApp>>;
  beforeAll(async () => {
    t = await makeTestApp();
  });
  afterAll(async () => {
    await t.cleanup();
  });

  it('вход закрыт паролем, учётные записи не раскрываются', async () => {
    const options = await t.app.inject({ method: 'GET', url: '/api/v1/auth/options' });
    expect(options.statusCode).toBe(200);
    expect(options.json()).toEqual({ open_access: false, accounts: [] });

    const empty = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: 'admin', password: '' } });
    expect(empty.statusCode).toBe(401);
    const right = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: 'admin', password: 'admin' } });
    expect(right.statusCode).toBe(200);
  });
});

describe('с флагом OPEN_ACCESS', () => {
  let t: Awaited<ReturnType<typeof makeTestApp>>;
  beforeAll(async () => {
    t = await makeTestApp({ openAccess: true });
  });
  afterAll(async () => {
    await t.cleanup();
  });

  it('список учётных записей — по ролям: инспектор, руководитель, администратор, ML-инженер', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/auth/options' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.open_access).toBe(true);
    const roles = body.accounts.map((a: { role: string }) => a.role);
    expect(roles).toEqual([...roles].sort((a: string, b: string) => ['INSPECTOR', 'SUPERVISOR', 'ADMIN', 'ML_ENGINEER'].indexOf(a) - ['INSPECTOR', 'SUPERVISOR', 'ADMIN', 'ML_ENGINEER'].indexOf(b)));
    expect(body.accounts.map((a: { login: string }) => a.login)).toEqual(expect.arrayContaining(['inspector', 'supervisor', 'admin', 'ml']));
    expect(JSON.stringify(body)).not.toContain('password');
  });

  it('вход без пароля с ролью учётной записи; журнал помечает открытый вход', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: 'admin', password: '' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.role).toBe('ADMIN');
    const me = await t.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${res.json().access_token}` } });
    expect(me.json().login).toBe('admin');
    const row = t.ctx.db.get<{ details: string }>("SELECT details FROM audit_log WHERE action = 'login' ORDER BY timestamp DESC LIMIT 1");
    expect(JSON.parse(row!.details)).toMatchObject({ login: 'admin', success: true, open_access: true });
  });

  it('несуществующая учётная запись — по-прежнему 401', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: 'nobody', password: '' } });
    expect(res.statusCode).toBe(401);
  });

  it('без токена остальное api по-прежнему закрыто', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/objects' });
    expect(res.statusCode).toBe(401);
  });
});

describe('Telegram: открытый вход подписан', () => {
  it('«вход ✓ без пароля»', () => {
    const text = telegramText({ action: 'login', timestamp: '2026-09-30T07:00:00Z', details: { login: 'admin', success: true, open_access: true } });
    expect(text).toBe('30.09 10:00:00 МСК · admin · вход ✓ без пароля');
  });
});
