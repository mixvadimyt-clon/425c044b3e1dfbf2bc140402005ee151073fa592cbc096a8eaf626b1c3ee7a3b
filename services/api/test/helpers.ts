import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { buildApp, type BuildOptions } from '../src/app.js';
import { type AppConfig, loadConfig } from '../src/config.js';

export async function makePdf(pages = 2, text = 'test'): Promise<Buffer> {
  const doc = await PDFDocument.create();
  // фиксированные даты → одинаковое содержимое даёт одинаковый sha256 (проверка дубликатов)
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`${text} page ${i + 1}`, { x: 50, y: 800, size: 12, font });
  }
  return Buffer.from(await doc.save());
}

export interface Part {
  name: string;
  value?: string;
  filename?: string;
  content?: Buffer;
  contentType?: string;
}

export function multipart(parts: Part[]): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----inspector' + Math.random().toString(16).slice(2);
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (p.filename !== undefined) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n` +
            `Content-Type: ${p.contentType ?? 'application/pdf'}\r\n\r\n`,
        ),
      );
      chunks.push(p.content ?? Buffer.alloc(0));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value ?? ''}`));
    }
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const payload = Buffer.concat(chunks);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(payload.length) } };
}

export async function makeTestApp(overrides: Partial<AppConfig> = {}, opts: Omit<BuildOptions, 'config'> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'inspector-api-'));
  const base = loadConfig();
  const config = loadConfig({
    dbPath: path.join(dir, 'test.sqlite'),
    storageDir: path.join(dir, 'storage'),
    sweepIntervalMs: 60_000,
    // Сценарии тестов (заглушка ML, экспорт) построены вокруг двух параметров. У продукта по
    // умолчанию активна вся матрица — это проверяет импорт матрицы с ALL.
    initialActiveParams: ['M-002', 'M-055'],
    ...overrides,
    ml: { ...base.ml, transport: 'stub', stubDelayMs: 10, ...(overrides.ml ?? {}) },
  });
  const { app, ctx } = await buildApp({ config, logger: false, ...opts });
  await app.ready();
  const cleanup = async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { app, ctx, cleanup };
}

export async function login(app: FastifyInstance, loginName: string): Promise<Record<string, string>> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: loginName, password: loginName } });
  if (res.statusCode !== 200) throw new Error(`login ${loginName}: ${res.statusCode} ${res.body}`);
  return { authorization: `Bearer ${res.json().access_token}` };
}

export async function waitFor<T>(fn: () => Promise<T>, until: (v: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (until(v)) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
