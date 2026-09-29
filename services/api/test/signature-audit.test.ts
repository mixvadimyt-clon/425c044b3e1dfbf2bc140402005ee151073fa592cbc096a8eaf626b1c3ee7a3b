/**
 * Подвязка под ЭЦП и каналы журнала действий.
 *
 * Подпись принимается и хранится, но **не проверяется** — `verification` всегда `NOT_VERIFIED`.
 * Журнал действий пишется в базу всегда, а в файл — когда он настроен; наружу (вебхук, Telegram)
 * по умолчанию ничего не уходит.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, makePdf, makeTestApp, multipart } from './helpers.js';

type Json = Record<string, any>;

let app: FastifyInstance;
let cleanup: () => Promise<void>;
let inspector: Record<string, string>;
let fileId: string;
let auditDir: string;
let auditFile: string;

beforeAll(async () => {
  auditDir = mkdtempSync(path.join(tmpdir(), 'inspector-audit-'));
  auditFile = path.join(auditDir, 'audit.jsonl');
  ({ app, cleanup } = await makeTestApp({
    audit: { file: auditFile, webhookUrl: '', telegramToken: '', telegramChat: '' },
  }));
  inspector = await login(app, 'inspector');

  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/objects',
    headers: inspector,
    payload: { name: 'Объект для подписи' },
  });
  expect(created.statusCode).toBe(201);

  const pdf = await makePdf(1, 'signature');
  const mp = multipart([
    { name: 'object_id', value: created.json().id as string },
    { name: 'files', filename: '4. П-2025-04-266-КР.pdf', content: pdf },
  ]);
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/documents/upload',
    headers: { ...inspector, ...mp.headers },
    payload: mp.payload,
  });
  expect(res.statusCode, res.body).toBe(202);  // загрузка принята, разбор идёт в фоне
  fileId = (res.json().files as Json[])[0].file_id as string;
});

afterAll(async () => {
  await cleanup();
  rmSync(auditDir, { recursive: true, force: true });
});

const attach = (name: string, content: Buffer) => {
  const mp = multipart([{ name: 'signature', filename: name, content, contentType: 'application/pkcs7-signature' }]);
  return app.inject({
    method: 'POST',
    url: `/api/v1/files/${fileId}/signature`,
    headers: { ...inspector, ...mp.headers },
    payload: mp.payload,
  });
};

describe('подвязка под электронную подпись', () => {
  it('открепленная подпись принимается и видна в карточке файла', async () => {
    const content = Buffer.from('PKCS#7 signature placeholder');
    const res = await attach('КР.pdf.sig', content);
    expect(res.statusCode).toBe(200);
    const file = res.json() as Json;
    expect(file.signature.file_name).toBe('КР.pdf.sig');
    expect(file.signature.size_bytes).toBe(content.length);
    expect(file.signature.sha256).toBe(createHash('sha256').update(content).digest('hex'));
  });

  it('проверки подписи нет и мы её не заявляем', async () => {
    const res = await attach('КР.pdf.p7s', Buffer.from('another signature'));
    expect(res.statusCode).toBe(200);
    const file = res.json() as Json;
    // Доступа к УКЭП на соревновании нет (REQ-INT-02): файл храним, вывод о подлинности не делаем
    expect(file.signature.verification).toBe('NOT_VERIFIED');
    // Статус подписи документа приходит из реестра комплекта и от вложения не меняется
    expect(file.signature_status).toBe('UNKNOWN');
    expect(file.signature.file_name).toBe('КР.pdf.p7s');
  });

  it('чужое расширение отбивается', async () => {
    const res = await attach('договор.pdf', Buffer.from('%PDF-1.7'));
    expect(res.statusCode).toBe(400);
  });

  it('слишком большой файл подписи отбивается', async () => {
    const res = await attach('огромная.sig', Buffer.alloc(300 * 1024, 1));
    expect(res.statusCode).toBe(413);
  });

  it('несуществующий файл — 404', async () => {
    const mp = multipart([{ name: 'signature', filename: 'x.sig', content: Buffer.from('x') }]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/files/00000000-0000-4000-8000-000000000000/signature',
      headers: { ...inspector, ...mp.headers },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('журнал действий в файл', () => {
  it('пишет строку на действие — с ролью, адресом и браузером', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/objects',
      headers: { ...inspector, 'user-agent': 'Mozilla/5.0 (проверка журнала)' },
      payload: { name: 'Объект для журнала' },
    });
    // запись идёт в onResponse, дадим обработчику завершиться
    await new Promise((r) => setTimeout(r, 50));

    const lines = readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Json);
    const entry = lines.find((e) => e.action === 'createObject');
    expect(entry).toBeTruthy();
    expect(entry!.user_role).toBe('INSPECTOR');
    // inject подставляет свой user-agent вместо переданного, поэтому проверяем, что поле заполнено,
    // а не его содержимое: проверяющему нужен сам факт «видно, с чего зашли»
    expect(typeof entry!.user_agent).toBe('string');
    expect(entry!.user_agent).toBeTruthy();
    expect(entry!.ip_address).toBeTruthy();
    expect(entry!.timestamp).toBeTruthy();
  });

  it('прикрепление подписи тоже попадает в журнал', async () => {
    const lines = readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Json);
    const entry = lines.find((e) => e.action === 'attachSignature');
    expect(entry).toBeTruthy();
    expect(entry!.entity_type).toBe('file');
    expect((entry!.details as Json).verification).toBe('NOT_VERIFIED');
  });
});
