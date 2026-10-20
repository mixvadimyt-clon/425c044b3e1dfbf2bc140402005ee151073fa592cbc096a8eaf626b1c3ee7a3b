/**
 * Журнал действий в Telegram (стенд 28.09): время МСК, логин, итог, адрес и браузер.
 * Настоящий Telegram не вызываем — fetch подменён, проверяем адрес и текст сообщения.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { Db } from '../src/db/sqlite.js';
import { audit, setAuditSinks, TELEGRAM_INTERVAL_MS, TELEGRAM_MAX_TEXT, telegramText } from '../src/modules/notify.js';
import { login, makeTestApp } from './helpers.js';

const CHROME_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

describe('текст сообщения в Telegram', () => {
  it('вход: логин из запроса, время по Москве, короткий браузер', () => {
    const text = telegramText({
      action: 'login',
      timestamp: '2026-09-28T08:12:03.456Z',
      details: { login: 'inspector', success: true },
      ip_address: '89.124.104.35',
      user_agent: CHROME_WINDOWS,
    });
    expect(text).toBe('28.09 11:12:03 МСК · inspector · вход ✓\n89.124.104.35 · Chrome · Windows');
  });

  it('неверный пароль и блокировка входа различаются', () => {
    const base = { action: 'login', timestamp: '2026-09-28T21:00:00Z', ip_address: '1.2.3.4' };
    expect(telegramText({ ...base, details: { login: 'admin', success: false } })).toBe('29.09 00:00:00 МСК · admin · неверный пароль\n1.2.3.4');
    expect(telegramText({ ...base, details: { login: 'admin', success: false, blocked: true } })).toContain('admin · вход заблокирован');
  });

  it('действие: логин из базы, код ответа; без пользователя — роль или «система»', () => {
    const entry = { action: 'decideFinding', timestamp: '2026-09-28T08:00:00Z', user_role: 'INSPECTOR', details: { status_code: 200 } };
    expect(telegramText(entry, 'inspector')).toBe('28.09 11:00:00 МСК · inspector · decideFinding → 200');
    expect(telegramText(entry)).toBe('28.09 11:00:00 МСК · inspector · decideFinding → 200');
    expect(telegramText({ action: 'rinPoll', timestamp: '2026-09-28T08:00:00Z' })).toBe('28.09 11:00:00 МСК · система · rinPoll');
  });
});

describe('отправка в Telegram из приложения', () => {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  let t: Awaited<ReturnType<typeof makeTestApp>>;

  beforeAll(async () => {
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', (url: string | URL, init?: RequestInit) => {
      if (String(url).startsWith('https://api.telegram.org/')) {
        sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return Promise.resolve(new Response('{"ok":true}'));
      }
      return real(url, init);
    });
    t = await makeTestApp({ audit: { file: '', webhookUrl: '', telegramToken: 'T0K', telegramChat: '-100123' } });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await t.cleanup();
  });

  it('вход и действие уходят в чат с логином, без звука', async () => {
    const headers = await login(t.app, 'inspector');
    await t.app.inject({ method: 'POST', url: '/api/v1/objects', headers: { ...headers, 'user-agent': CHROME_WINDOWS }, payload: { name: 'Объект для Telegram' } });
    // вход уходит сразу, создание объекта — следующим сообщением после паузы очереди
    await vi.waitFor(() => expect(sent.map((m) => String(m.body.text)).join('\n')).toContain('createObject'), { timeout: 8000 });
    expect(sent.every((m) => m.url === 'https://api.telegram.org/botT0K/sendMessage')).toBe(true);
    expect(sent.every((m) => m.body.chat_id === '-100123' && m.body.disable_notification === true)).toBe(true);
    const texts = sent.map((m) => String(m.body.text));
    expect(texts.some((x) => x.includes('inspector · вход ✓'))).toBe(true);
    expect(texts.some((x) => x.includes('inspector · createObject → 201') && x.includes('Chrome · Windows'))).toBe(true);
  }, 15_000);
});

describe('отказ Telegram виден в логе api', () => {
  afterAll(() => vi.unstubAllGlobals());

  it('«chat not found» — в лог с каналом, кодом и причиной, без токена', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response('{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}', { status: 400 })),
    );
    const warn = vi.fn();
    const db = new Db(':memory:');
    db.migrate();
    setAuditSinks({ audit: { file: '', webhookUrl: '', telegramToken: '123:SECRET', telegramChat: '5508987749' } } as unknown as AppConfig, { warn });
    audit(db, { action: 'login', details: { login: 'inspector', success: true }, ip_address: '1.2.3.4' });
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    const [fields, message] = warn.mock.calls[0];
    expect(fields).toEqual({ channel: 'telegram', status: 400, description: 'Bad Request: chat not found' });
    expect(message).toBe('Канал журнала действий отказал в приёме записи');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET');
  });

  it('успешная отправка в лог не пишется', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('{"ok":true}')));
    const warn = vi.fn();
    const db = new Db(':memory:');
    db.migrate();
    setAuditSinks({ audit: { file: '', webhookUrl: '', telegramToken: '123:SECRET', telegramChat: '-5508987749' } } as unknown as AppConfig, { warn });
    audit(db, { action: 'login', details: { login: 'inspector', success: true } });
    await new Promise((r) => setTimeout(r, 50));
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('повтор отправки в Telegram', () => {
  const run = async (responses: (() => Promise<Response>)[]) => {
    const calls: number[] = [];
    vi.stubGlobal('fetch', () => {
      calls.push(Date.now());
      return (responses[calls.length - 1] ?? responses[responses.length - 1])();
    });
    const warn = vi.fn();
    const db = new Db(':memory:');
    db.migrate();
    setAuditSinks({ audit: { file: '', webhookUrl: '', telegramToken: '123:SECRET', telegramChat: '-5508987749' } } as unknown as AppConfig, { warn });
    audit(db, { action: 'login', details: { login: 'inspector', success: true } });
    await vi.advanceTimersByTimeAsync(35_000);
    return { calls, warn };
  };
  const offline = () => Promise.reject(new TypeError('fetch failed'));
  const ok = () => Promise.resolve(new Response('{"ok":true}'));

  beforeAll(() => {
    vi.useFakeTimers();
  });
  afterAll(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('сетевая ошибка — один повтор через паузу, в лог ничего', async () => {
    const { calls, warn } = await run([offline, ok]);
    expect(calls).toHaveLength(2);
    expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(2000);
    expect(warn).not.toHaveBeenCalled();
  });

  it('две сетевые ошибки подряд — в лог, третьей попытки нет', async () => {
    const { calls, warn } = await run([offline, offline]);
    expect(calls).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toBe('Не удалось отправить запись журнала действий');
  });

  it('пачка записей — не чаще одного сообщения за паузу, накопившееся склеивается, ничего не теряется', async () => {
    const texts: string[] = [];
    const calls: number[] = [];
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      calls.push(Date.now());
      texts.push(String(JSON.parse(String(init?.body)).text));
      return ok();
    });
    const warn = vi.fn();
    const db = new Db(':memory:');
    db.migrate();
    setAuditSinks({ audit: { file: '', webhookUrl: '', telegramToken: '123:SECRET', telegramChat: '-5508987749' } } as unknown as AppConfig, { warn });
    for (let i = 1; i <= 120; i += 1) audit(db, { action: `step${i}x`, details: { status_code: 200 } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(warn).not.toHaveBeenCalled();
    // первая запись — сразу, остальные 119 — склеенными сообщениями не длиннее предела Telegram
    expect(texts[0]).toContain('step1x');
    expect(texts[0]).not.toContain('step2x');
    expect(texts.length).toBeGreaterThanOrEqual(3);
    expect(texts.length).toBeLessThan(10);
    expect(texts.every((x) => x.length <= TELEGRAM_MAX_TEXT)).toBe(true);
    const all = texts.join('\n');
    for (let i = 1; i <= 120; i += 1) expect(all).toContain(`step${i}x`);
    for (let i = 1; i < calls.length; i += 1) expect(calls[i] - calls[i - 1]).toBeGreaterThanOrEqual(TELEGRAM_INTERVAL_MS);
  });

  it('429 — ждём retry_after и отправляем ещё раз', async () => {
    const tooMany = () =>
      Promise.resolve(new Response('{"ok":false,"error_code":429,"description":"Too Many Requests: retry after 5","parameters":{"retry_after":5}}', { status: 429 }));
    const { calls, warn } = await run([tooMany, ok]);
    expect(calls).toHaveLength(2);
    expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(5000);
    expect(warn).not.toHaveBeenCalled();
  });
});
