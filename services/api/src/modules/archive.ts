import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import type { DocStage } from '../types.js';
import type { IntakeFile } from './intake.js';
import { fixMojibakeName, stageFromFolder } from './names.js';
import { looksLikeRegistry } from './registry.js';
import type { LocalStorage } from './storage.js';
import { type ReceivedFile, ZIP_EXT } from './upload.js';

/** Форматы, которые серверный импорт и автозабор принимают карточкой без анализа (у организаторов FORMAT_CARD_ONLY). */
export const CARD_ONLY_EXT = /\.(zip|7z|rar|dwg|dxf|doc|xls|xlsx|rtf|tiff?|jpe?g|png)$/i;
/** Архивы больше этого размера не распаковываем в память — остаются карточкой. */
export const UNZIP_MAX_BYTES = 1024 * 1024 * 1024;

/**
 * Пределы распаковки. Размер самого архива ничего не говорит о распакованном объёме: PDF внутри
 * zip почти не сжимается, а специально собранный архив из нулей разворачивается в тысячу раз.
 * `unzipSync` держит всё в памяти, поэтому считаем объём до распаковки — `filter` получает
 * `originalSize` из оглавления архива.
 */
export interface UnzipLimits {
  /** Суммарный распакованный объём. */
  totalBytes: number;
  /** Один файл внутри архива. */
  entryBytes: number;
  /** Число файлов. */
  entries: number;
}

export const UNZIP_LIMITS: UnzipLimits = {
  totalBytes: 2 * 1024 * 1024 * 1024,
  entryBytes: 1024 * 1024 * 1024,
  entries: 5000,
};

const gb = (bytes: number): string => `${(bytes / 1024 / 1024 / 1024).toFixed(1)} ГБ`;

/** Архив больше пределов распаковки — отличаем от битого архива, чтобы назвать причину отказа. */
export class ArchiveTooLargeError extends Error {}

/** Имя файла внутри zip: UTF-8, а у архивов из Windows без флага UTF-8 — CP866 (fflate отдаёт его как latin1). */
export function zipEntryName(raw: string): string {
  if ([...raw].some((ch) => ch.charCodeAt(0) > 0xff) || !/[^\x00-\x7f]/.test(raw)) return raw;
  const bytes = Buffer.from(raw, 'latin1');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('ibm866').decode(bytes);
  }
}

/**
 * Содержимое .zip как отдельные файлы комплекта: путь «архив/файл» (как в реестре организаторов),
 * стадия — по папкам внутри архива, иначе по папке архива. Сам архив остаётся карточкой (его добавляет вызывающий).
 * Бросает исключение, если архив не распаковывается.
 */
export function expandZip(
  storage: LocalStorage,
  content: Uint8Array,
  archive: { relParts: string[]; folderStage: DocStage | null },
  fixNames: boolean,
  limits: UnzipLimits = UNZIP_LIMITS,
): IntakeFile[] {
  const files: IntakeFile[] = [];
  let total = 0;
  let count = 0;
  // Бросаем исключение, а не пропускаем файл: половина комплекта хуже, чем архив карточкой.
  // Вызывающий это ловит и оставляет архив нераспакованным, записав причину в журнал.
  const filter = (entry: { name: string; originalSize: number }): boolean => {
    if (entry.name.endsWith('/')) return false;
    if (entry.originalSize > limits.entryBytes) {
      throw new ArchiveTooLargeError(`«${entry.name}» распаковывается в ${gb(entry.originalSize)}, больше предела ${gb(limits.entryBytes)}`);
    }
    total += entry.originalSize;
    count += 1;
    if (total > limits.totalBytes) {
      throw new ArchiveTooLargeError(`распакованный объём больше ${gb(limits.totalBytes)}`);
    }
    if (count > limits.entries) {
      throw new ArchiveTooLargeError(`файлов в архиве больше ${limits.entries}`);
    }
    return true;
  };
  for (const [rawName, data] of Object.entries(unzipSync(content, { filter }))) {
    // «\» тоже разделитель: Compress-Archive из PowerShell 5.1 пишет пути через обратную косую,
    // хотя формат zip требует «/»
    const parts = zipEntryName(rawName)
      .split(/[\\/]+/)
      .filter(Boolean)
      .map((x) => (fixNames ? fixMojibakeName(x) : x));
    if (rawName.endsWith('/') || data.length === 0 || parts.some((x) => x.startsWith('.') || x === '__MACOSX')) continue;
    const tmpPath = storage.tmpPath(randomUUID());
    writeFileSync(tmpPath, data);
    files.push({
      originalName: parts[parts.length - 1],
      relPath: [...archive.relParts, ...parts].join('/'),
      folderStage: parts.slice(0, -1).map(stageFromFolder).find(Boolean) ?? archive.folderStage ?? null,
      tmpPath,
      sizeBytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      truncated: false,
      allowCardOnly: CARD_ONLY_EXT.test(parts[parts.length - 1]),
    });
  }
  return files;
}

/** Реестр комплекта, найденный среди загруженных файлов (в корне папки или архива). */
export interface FoundRegistry {
  originalName: string;
  buffer: Buffer;
  sha256: string;
}

/**
 * Загрузка через интерфейс: архив .zip и папка целиком, как при серверном импорте.
 *
 * - **архив, выбранный как файл,** — упаковка комплекта: раскрывается, сам в комплект не входит.
 *   Не раскрылся — отказ с причиной, а не молчаливая карточка: пользователь ждал документы;
 * - **архив внутри загруженной папки** — как при импорте: карточка файла плюс содержимое;
 * - **неподдерживаемые форматы из папки или архива** (DWG, изображения) — карточкой, без анализа.
 *   Отдельно выбранный такой файл по-прежнему отклоняется: его явно просили проверить;
 * - **реестр** (`registry.csv`, `реестр*.xlsx`…) ближе всего к корню — реестр комплекта,
 *   документом не считается. Явно переданный в форме реестр важнее найденного.
 */
export function unpackUpload(storage: LocalStorage, received: ReceivedFile[]): { files: IntakeFile[]; registry: FoundRegistry | null } {
  const files: IntakeFile[] = [];
  for (const f of received) {
    const inFolder = Boolean(f.relPath);
    if (!ZIP_EXT.test(f.originalName) || f.truncated) {
      files.push({ ...f, allowCardOnly: inFolder && CARD_ONLY_EXT.test(f.originalName) });
      continue;
    }
    let contents: IntakeFile[];
    try {
      const relParts = f.relPath ? f.relPath.split('/') : [];
      contents = expandZip(storage, readFileSync(f.tmpPath), { relParts, folderStage: f.folderStage ?? null }, true);
    } catch (err) {
      const tooLarge = err instanceof ArchiveTooLargeError;
      const rejection = {
        code: tooLarge ? ('FILE_TOO_LARGE' as const) : ('CORRUPTED_FILE' as const),
        message: `Архив не распакован: ${tooLarge ? (err as Error).message : 'файл повреждён или это не zip'}`,
      };
      files.push(inFolder ? { ...f, allowCardOnly: true } : { ...f, rejection });
      continue;
    }
    if (inFolder) files.push({ ...f, allowCardOnly: true });
    else rmSync(f.tmpPath, { force: true });
    files.push(...contents);
  }

  const depth = (f: IntakeFile) => (f.relPath ?? f.originalName).split('/').length;
  const found = files.filter((f) => looksLikeRegistry(f.originalName)).sort((a, b) => depth(a) - depth(b))[0];
  if (!found) return { files, registry: null };
  const buffer = readFileSync(found.tmpPath);
  rmSync(found.tmpPath, { force: true });
  return { files: files.filter((f) => f !== found), registry: { originalName: found.originalName, buffer, sha256: found.sha256 } };
}
