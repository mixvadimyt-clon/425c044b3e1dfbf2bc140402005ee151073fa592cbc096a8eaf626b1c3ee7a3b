import { createHash, randomUUID } from 'node:crypto';
import { closeSync, createWriteStream, openSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { FastifyRequest } from 'fastify';
import type {} from '@fastify/multipart';
import { PDFDocument } from 'pdf-lib';
import type { AppConfig } from '../config.js';
import { ApiError } from '../errors.js';
import type { DocStage, S } from '../types.js';
import { stageFromFolder } from './names.js';
import type { LocalStorage } from './storage.js';

export type FileFormat = S['FileFormat'];
export type UploadErrorCode = S['UploadErrorCode'];

export interface ReceivedFile {
  originalName: string;
  tmpPath: string;
  sizeBytes: number;
  sha256: string;
  truncated: boolean;
  /** Путь внутри загруженной папки или импортируемого каталога (для сопоставления с реестром). */
  relPath?: string;
  /** Стадия по имени папки («Проектная документация» и т.п.). */
  folderStage?: DocStage | null;
}

/** Архив .zip: при загрузке через интерфейс раскрывается, поэтому его предел — предел пакета, а не файла. */
export const ZIP_EXT = /\.zip$/i;

/**
 * Имя файла из формы. При выборе папки браузер присылает путь («Проектная документация/ПЗ.pdf»):
 * имя — последний сегмент, путь идёт в `relPath`, стадия — по папкам. «..» и пустые сегменты
 * отбрасываются: путь только подпись, файл всё равно пишется во временное хранилище под своим uuid.
 */
export function uploadPath(raw: string): Pick<ReceivedFile, 'originalName' | 'relPath' | 'folderStage'> {
  const parts = raw.split(/[\\/]+/).filter((p) => p && p !== '.' && p !== '..');
  const originalName = parts.pop() || 'file';
  if (parts.length === 0) return { originalName, folderStage: null };
  return { originalName, relPath: [...parts, originalName].join('/'), folderStage: parts.map(stageFromFolder).find(Boolean) ?? null };
}

export interface CheckedFile extends ReceivedFile {
  format: FileFormat | null;
  pagesCount: number | null;
  error: { code: UploadErrorCode; message: string } | null;
}

export interface UploadFields {
  object_id?: string;
  process_id?: string;
  auto_start?: string;
  stage_hints?: string;
  manifest?: string;
}

/** Файл реестра из поля registry — читается в память, документом не считается. */
export interface RegistryUpload {
  originalName: string;
  buffer: Buffer;
  sha256: string;
}

export const REGISTRY_MAX_BYTES = 10 * 1024 * 1024;

const MB = 1024 * 1024;

export const uploadMessages = {
  UNSUPPORTED_FORMAT: 'Неподдерживаемый формат файла. Допустимые форматы: PDF, DOCX, XML.',
  CORRUPTED_FILE: 'Файл повреждён или не читается. Загрузите файл повторно.',
  FILE_TOO_LARGE: (max: number) => `Файл больше допустимого размера ${Math.round(max / MB)} МБ.`,
  BATCH_TOO_LARGE: (max: number) => `Общий размер пакета превышает лимит ${Math.round(max / MB)} МБ. Пакет отклонён.`,
  VIRUS_DETECTED: 'Файл не прошёл антивирусную проверку и не сохранён.',
  FILE_ID_CONFLICT: (fileId: string) =>
    `Файл с идентификатором ${fileId} уже загружен с другим содержимым. Перезапись под тем же file_id запрещена: присвойте новой редакции новый file_id.`,
} as const;

/** Приём multipart: поля + файлы во временные файлы с подсчётом sha256 и размера. */
export async function receiveMultipart(
  req: FastifyRequest,
  storage: LocalStorage,
  config: AppConfig,
): Promise<{ fields: UploadFields; files: ReceivedFile[]; registry: RegistryUpload | null }> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > config.uploadMaxBatchBytes + 2 * MB) {
    throw new ApiError(413, 'BATCH_TOO_LARGE', uploadMessages.BATCH_TOO_LARGE(config.uploadMaxBatchBytes), {
      max_bytes: config.uploadMaxBatchBytes,
    });
  }
  const fields: UploadFields = {};
  const files: ReceivedFile[] = [];
  let registry: RegistryUpload | null = null;
  let total = 0;
  const cleanup = () => files.forEach((f) => rmSync(f.tmpPath, { force: true }));
  try {
    // preservePath: путь из имени файла нужен, чтобы папки стадий работали при загрузке папки целиком
    const fileSize = Math.max(config.uploadMaxFileBytes, config.uploadMaxBatchBytes) + 1;
    for await (const part of req.parts({ preservePath: true, limits: { fileSize, files: 200 } })) {
      if (part.type === 'field') {
        if (['object_id', 'process_id', 'auto_start', 'stage_hints', 'manifest'].includes(part.fieldname)) {
          (fields as Record<string, string>)[part.fieldname] = String(part.value);
        }
        continue;
      }
      if (part.fieldname === 'registry') {
        const buffer = await part.toBuffer();
        if (buffer.length > REGISTRY_MAX_BYTES) {
          throw new ApiError(400, 'REGISTRY_INVALID', 'Файл реестра больше 10 МБ');
        }
        total += buffer.length;
        registry = { originalName: part.filename || 'registry', buffer, sha256: createHash('sha256').update(buffer).digest('hex') };
        continue;
      }
      const tmpPath = storage.tmpPath(randomUUID());
      const hash = createHash('sha256');
      let size = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          size += chunk.length;
          total += chunk.length;
          hash.update(chunk);
          if (total > config.uploadMaxBatchBytes) {
            cb(new ApiError(413, 'BATCH_TOO_LARGE', uploadMessages.BATCH_TOO_LARGE(config.uploadMaxBatchBytes)));
            return;
          }
          cb(null, chunk);
        },
      });
      files.push({ ...uploadPath(part.filename || 'file'), tmpPath, sizeBytes: 0, sha256: '', truncated: false });
      await pipeline(part.file, meter, createWriteStream(tmpPath));
      const rec = files[files.length - 1];
      rec.sizeBytes = size;
      rec.sha256 = hash.digest('hex');
      const limit = ZIP_EXT.test(rec.originalName) ? config.uploadMaxBatchBytes : config.uploadMaxFileBytes;
      rec.truncated = part.file.truncated || size > limit;
    }
  } catch (err) {
    cleanup();
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, 'BAD_MULTIPART', 'Не удалось прочитать загружаемые файлы', { reason: String(err) });
  }
  return { fields, files, registry };
}

function readHead(file: string, bytes: number): Buffer {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

function readTail(file: string, bytes: number): Buffer {
  const size = statSync(file).size;
  const fd = openSync(file, 'r');
  try {
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf;
  } finally {
    closeSync(fd);
  }
}

/** Определение формата по содержимому (magic bytes) с учётом расширения. */
export function sniffFormat(file: string, name: string): FileFormat | null {
  const head = readHead(file, 1024);
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (head.includes(Buffer.from('%PDF-'))) return 'PDF';
  if (head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) && ext === 'docx') return 'DOCX';
  const text = head.toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (text.startsWith('<') && ext === 'xml') return 'XML';
  return null;
}

/** Целостность PDF: заголовок + маркер конца (%%EOF). Число страниц — best effort через pdf-lib. */
export async function inspectPdf(file: string): Promise<{ ok: boolean; pages: number | null }> {
  const tail = readTail(file, 2048).toString('latin1');
  if (!tail.includes('%%EOF')) return { ok: false, pages: null };
  try {
    const doc = await PDFDocument.load(readFileSync(file), {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: false,
    });
    return { ok: true, pages: doc.getPageCount() };
  } catch {
    // pdf-lib строже реальных просмотрщиков: не считаем файл битым, если есть заголовок и %%EOF
    return { ok: true, pages: null };
  }
}

/** Антивирус (clamd INSTREAM). Возвращает true, если файл чистый. */
export function scanWithClamav(file: string, host: string, port: number, timeoutMs = 60_000): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let reply = '';
    const timer = setTimeout(() => socket.destroy(new Error('ClamAV timeout')), timeoutMs);
    socket.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    socket.on('data', (d) => (reply += d.toString()));
    socket.on('end', () => {
      clearTimeout(timer);
      resolve(/:\s*OK/.test(reply) && !/FOUND/.test(reply));
    });
    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      const data = readFileSync(file);
      const CHUNK = 64 * 1024;
      for (let i = 0; i < data.length; i += CHUNK) {
        const chunk = data.subarray(i, i + CHUNK);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(chunk.length);
        socket.write(len);
        socket.write(chunk);
      }
      socket.end(Buffer.alloc(4));
    });
  });
}

/** Проверки одного файла по REQ-UPL-02..04, 08. */
export async function checkFile(f: ReceivedFile, config: AppConfig): Promise<CheckedFile> {
  const fail = (code: UploadErrorCode, message: string): CheckedFile => ({ ...f, format: null, pagesCount: null, error: { code, message } });
  if (f.truncated) return fail('FILE_TOO_LARGE', uploadMessages.FILE_TOO_LARGE(config.uploadMaxFileBytes));
  if (f.sizeBytes === 0) return fail('CORRUPTED_FILE', uploadMessages.CORRUPTED_FILE);
  const format = sniffFormat(f.tmpPath, f.originalName);
  if (!format) return fail('UNSUPPORTED_FORMAT', uploadMessages.UNSUPPORTED_FORMAT);
  let pagesCount: number | null = null;
  if (format === 'PDF') {
    const pdf = await inspectPdf(f.tmpPath);
    if (!pdf.ok) return fail('CORRUPTED_FILE', uploadMessages.CORRUPTED_FILE);
    pagesCount = pdf.pages;
  }
  if (config.clamav.enabled) {
    const clean = await scanWithClamav(f.tmpPath, config.clamav.host, config.clamav.port);
    if (!clean) return fail('VIRUS_DETECTED', uploadMessages.VIRUS_DETECTED);
  }
  return { ...f, format, pagesCount, error: null };
}
