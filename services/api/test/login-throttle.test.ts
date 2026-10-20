import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { makeTestApp } from './helpers.js';

/** Демо-пользователи в тестах входят с паролем, равным логину (DEMO_PASSWORD не задан). */
async function setup(overrides: Partial<AppConfig> = {}) {
  const t = await makeTestApp({ login: { maxFailures: 3, maxFailuresPerIp: 5, windowMs: 60_000 }, trustProxy: 1, ...overrides });
  const attempt = (login: string, password: string, ip: string, forwardedFor?: string) =>
    t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login, password },
      remoteAddress: ip,
      headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
    });
  return { ...t, attempt };
}

describe('ограничение попыток входа', () => {
  it('после 3 неудач с одного адреса — 429 с Retry-After, даже с верным паролем', async () => {
    const t = await setup();
    try {
      for (let i = 0; i < 3; i++) expect((await t.attempt('inspector', 'не тот', '10.0.0.1')).statusCode).toBe(401);

      const blocked = await t.attempt('inspector', 'inspector', '10.0.0.1');
      expect(blocked.statusCode).toBe(429);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      expect(blocked.json()).toMatchObject({ code: 'TOO_MANY_LOGIN_ATTEMPTS', details: { retry_after_s: expect.any(Number) } });
      expect(blocked.json().message).toContain('Повторите через');
    } finally {
      await t.cleanup();
    }
  });

  it('с другого адреса тот же логин входит: общую демо-учётку посторонний не запрёт', async () => {
    const t = await setup();
    try {
      for (let i = 0; i < 3; i++) await t.attempt('inspector', 'не тот', '10.0.0.1');
      expect((await t.attempt('inspector', 'inspector', '10.0.0.1')).statusCode).toBe(429);
      expect((await t.attempt('inspector', 'inspector', '10.0.0.2')).statusCode).toBe(200);
    } finally {
      await t.cleanup();
    }
  });

  it('успешный вход обнуляет счётчик пары «логин + адрес»', async () => {
    const t = await setup();
    try {
      for (let i = 0; i < 2; i++) await t.attempt('inspector', 'не тот', '10.0.0.1');
      expect((await t.attempt('inspector', 'inspector', '10.0.0.1')).statusCode).toBe(200);
      for (let i = 0; i < 2; i++) expect((await t.attempt('inspector', 'не тот', '10.0.0.1')).statusCode).toBe(401);
      expect((await t.attempt('inspector', 'inspector', '10.0.0.1')).statusCode).toBe(200);
    } finally {
      await t.cleanup();
    }
  });

  it('перебор по многим логинам с одного адреса упирается в лимит адреса', async () => {
    const t = await setup();
    try {
      for (const login of ['a1', 'a2', 'a3', 'a4', 'a5']) expect((await t.attempt(login, 'x', '10.0.0.7')).statusCode).toBe(401);
      expect((await t.attempt('supervisor', 'supervisor', '10.0.0.7')).statusCode).toBe(429);
      expect((await t.attempt('supervisor', 'supervisor', '10.0.0.8')).statusCode).toBe(200);
    } finally {
      await t.cleanup();
    }
  });

  it('окно скользящее: когда неудачи выпадают из окна, вход открывается', async () => {
    // окно с запасом: каждая неудачная попытка — медленная проверка пароля, и под нагрузкой три
    // попытки занимали больше 300 мс — первая выпадала из окна раньше, чем проверялась блокировка
    const t = await setup({ login: { maxFailures: 3, maxFailuresPerIp: 5, windowMs: 2000 } });
    try {
      for (let i = 0; i < 3; i++) await t.attempt('inspector', 'не тот', '10.0.0.1');
      expect((await t.attempt('inspector', 'inspector', '10.0.0.1')).statusCode).toBe(429);
      await new Promise((r) => setTimeout(r, 2100));
      expect((await t.attempt('inspector', 'inspector', '10.0.0.1')).statusCode).toBe(200);
    } finally {
      await t.cleanup();
    }
  });

  it('за прокси: адрес из X-Forwarded-For, подставленное клиентом слева не помогает обойти лимит', async () => {
    const t = await setup();
    try {
      // Caddy (172.18.0.5) дописывает настоящий адрес клиента последним; всё левее прислал клиент
      for (let i = 0; i < 3; i++) await t.attempt('inspector', 'не тот', '172.18.0.5', `1.1.1.${i}, 203.0.113.9`);
      expect((await t.attempt('inspector', 'inspector', '172.18.0.5', '9.9.9.9, 203.0.113.9')).statusCode).toBe(429);
      // другой настоящий клиент за тем же Caddy — не заперт
      expect((await t.attempt('inspector', 'inspector', '172.18.0.5', '203.0.113.10')).statusCode).toBe(200);
    } finally {
      await t.cleanup();
    }
  });

  it('без доверия прокси заголовок X-Forwarded-For не учитывается вовсе', async () => {
    const t = await setup({ trustProxy: 0 });
    try {
      for (let i = 0; i < 3; i++) await t.attempt('inspector', 'не тот', '10.0.0.1', `198.51.100.${i}`);
      expect((await t.attempt('inspector', 'inspector', '10.0.0.1', '198.51.100.99')).statusCode).toBe(429);
    } finally {
      await t.cleanup();
    }
  });
});
