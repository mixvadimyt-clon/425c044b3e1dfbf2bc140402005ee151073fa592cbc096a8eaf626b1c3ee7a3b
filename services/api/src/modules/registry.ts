import { badRequest } from '../errors.js';
import type { DocStage, S } from '../types.js';
import { type Cell, detectDelimiter, excelSerialToIsoDate, parseCsvRows, readXlsxFirstSheet } from './tabular.js';

/**
 * Реестр файлов комплекта («Перечень ИД» ред. 1.1, docs/domain/registry.md).
 * Принимаем CSV, XLSX и JSON; колонки — по-английски (как в контракте) или по-русски.
 */

export type RegistryFormat = 'CSV' | 'XLSX' | 'JSON';
type Entry = S['ManifestFile'];

export interface ParsedRegistry {
  format: RegistryFormat;
  manifest: S['UploadManifest'];
}

const REGISTRY_EXT = /\.(csv|xlsx|json|jsonl)$/i;
/** Имя файла похоже на реестр (для автопоиска при импорте папки), в том числе document_manifest.jsonl организаторов. */
export function looksLikeRegistry(fileName: string): boolean {
  return REGISTRY_EXT.test(fileName) && /^(document_)?(registry|manifest|реестр|перечень)/i.test(fileName.normalize('NFC'));
}

const key = (h: string) =>
  h
    .normalize('NFC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/g, '');

const ALIASES: Record<keyof Entry, string[]> = {
  file_id: ['fileid', 'идентификаторфайла', 'idфайла', 'кодфайла'],
  file_name: ['filename', 'имяфайла', 'исходноеимя', 'исходноеимяфайла', 'наименованиефайла', 'файл', 'originalname', 'relativepath', 'sourcerelativepath'],
  sha256: ['sha256', 'sha', 'хеш', 'хэш', 'контрольнаясумма', 'hash', 'sourcesha256'],
  object_id: ['objectid', 'идентификаторобъекта', 'надзорноедело', 'object'],
  doc_stage: ['docstage', 'stage', 'стадия'],
  discipline: ['discipline', 'раздел', 'марка', 'разделмарка', 'разделмаркакомплекта', 'section'],
  document_code: ['documentcode', 'code', 'шифр', 'шифрдокумента', 'шифркомплекта'],
  revision: ['revision', 'редакция', 'изменение', 'изм', 'номерредакции'],
  approval_status: ['approvalstatus', 'статусутверждения', 'статус'],
  approval_date: ['approvaldate', 'датаутверждения', 'датавыдачи', 'дата'],
  sheet_page_range: ['sheetpagerange', 'pagerange', 'диапазонлистов', 'листы', 'страницы', 'диапазонлистовстраниц'],
  predecessor_id: ['predecessorid', 'predecessor', 'предшественник', 'заменяет', 'предыдущаяредакция'],
  successor_id: ['successorid', 'successor', 'преемник', 'замененана', 'следующаяредакция'],
  predecessor_file_name: ['predecessorfilename', 'имяфайлапредыдущейредакции'],
  signature_status: ['signaturestatus', 'signature', 'подпись', 'статусподписи', 'укэп'],
  title: ['title', 'наименование', 'название', 'наименованиедокумента'],
};
const FIELD_BY_KEY = new Map<string, keyof Entry>(
  Object.entries(ALIASES).flatMap(([field, names]) => [[key(field), field as keyof Entry], ...names.map((n) => [n, field as keyof Entry] as const)]),
);

// --------------------------------------------------------------- значения

function stageOf(v: string): DocStage | null {
  const k = key(v);
  if (['pd', 'пд', 'проектная', 'проектнаядокументация'].includes(k)) return 'PD';
  if (['rd', 'рд', 'рабочая', 'рабочаядокументация'].includes(k)) return 'RD';
  if (['id', 'ид', 'исполнительная', 'исполнительнаядокументация'].includes(k)) return 'ID';
  return null;
}

function approvalOf(v: string): S['ApprovalStatus'] | null {
  const up = v.trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (['DRAFT', 'APPROVED', 'FOR_CONSTRUCTION', 'SUPERSEDED', 'CANCELLED', 'UNKNOWN'].includes(up)) return up as S['ApprovalStatus'];
  const k = key(v);
  if (k.startsWith('черновик') || k.startsWith('проект')) return 'DRAFT';
  if (k.includes('впроизводство') || k.includes('кпроизводству')) return 'FOR_CONSTRUCTION';
  if (k.startsWith('заменен') || k.startsWith('замещен')) return 'SUPERSEDED';
  if (k.startsWith('аннулир') || k.startsWith('отменен')) return 'CANCELLED';
  if (k.startsWith('утвержд') || k.startsWith('согласован')) return 'APPROVED';
  return null;
}

function signatureOf(v: string): S['SignatureStatus'] {
  const k = key(v);
  if (/^(signed|qes|absent|notrequired|unknown)$/.test(k)) return v.trim().toUpperCase().replace(/[\s-]+/g, '_') as S['SignatureStatus'];
  if (k.startsWith('нетреб')) return 'NOT_REQUIRED';
  if (k === 'нет' || k.startsWith('отсутств') || k.startsWith('неподписан') || k.startsWith('без')) return 'ABSENT';
  if (/укэп|кэп|^эп|эцп|электрон/.test(k)) return 'QES';
  if (k === 'да' || k === 'есть' || k.startsWith('подписан') || k.startsWith('имеется')) return 'SIGNED';
  return 'UNKNOWN';
}

function dateOf(v: Cell | undefined): string | null {
  if (typeof v === 'number') return excelSerialToIsoDate(v);
  const s = String(v ?? '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

const text = (v: Cell | undefined): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  return String(v).trim();
};

/** Одна строка реестра → ManifestFile; ошибки значений копим с номером строки. */
function normalizeEntry(raw: Partial<Record<keyof Entry, Cell>>, rowNo: number, errors: string[]): Entry | null {
  const e: Entry = {};
  const put = <K extends keyof Entry>(k: K, v: Entry[K] | null | undefined) => {
    if (v !== null && v !== undefined && v !== '') e[k] = v;
  };
  for (const k of ['file_id', 'file_name', 'object_id', 'discipline', 'document_code', 'revision', 'sheet_page_range', 'predecessor_id', 'successor_id', 'predecessor_file_name', 'title'] as const) {
    put(k, text(raw[k]) || undefined);
  }
  const sha = text(raw.sha256).toLowerCase();
  if (sha) {
    if (/^[0-9a-f]{64}$/.test(sha)) e.sha256 = sha;
    else errors.push(`строка ${rowNo}: sha256 должен состоять из 64 шестнадцатеричных символов`);
  }
  const stage = text(raw.doc_stage);
  if (stage) {
    const s = stageOf(stage);
    if (s) e.doc_stage = s;
    else errors.push(`строка ${rowNo}: неизвестная стадия «${stage}» (ожидается PD/RD/ID)`);
  }
  const approval = text(raw.approval_status);
  if (approval) {
    const a = approvalOf(approval);
    if (a) e.approval_status = a;
    else errors.push(`строка ${rowNo}: неизвестный статус утверждения «${approval}» (DRAFT/APPROVED/FOR_CONSTRUCTION/SUPERSEDED/CANCELLED)`);
  }
  if (raw.approval_date !== null && raw.approval_date !== undefined && text(raw.approval_date)) {
    const d = dateOf(raw.approval_date);
    if (d) e.approval_date = d;
    else errors.push(`строка ${rowNo}: дата утверждения «${text(raw.approval_date)}» не распознана (ГГГГ-ММ-ДД или ДД.ММ.ГГГГ)`);
  }
  const sign = text(raw.signature_status);
  if (sign) e.signature_status = signatureOf(sign);
  if (Object.keys(e).length === 0) return null; // пустая строка
  if (!e.file_name && !e.sha256) {
    errors.push(`строка ${rowNo}: нужен file_name или sha256, чтобы сопоставить запись с файлом`);
    return null;
  }
  return e;
}

/** Табличный реестр: ищем строку заголовка (до 10-й строки) — в ней должна быть колонка имени файла, file_id или sha256. */
function fromTable(rows: Cell[][]): S['UploadManifest'] {
  const headerIdx = rows.slice(0, 10).findIndex((r) => {
    const fields = r.map((c) => FIELD_BY_KEY.get(key(text(c))));
    return fields.includes('file_name') || fields.includes('sha256') || fields.includes('file_id');
  });
  if (headerIdx < 0) {
    throw badRequest(
      'В реестре не найдена строка заголовка: нужны колонки file_name (имя файла), file_id или sha256',
      undefined,
      'REGISTRY_INVALID',
    );
  }
  const columns = rows[headerIdx].map((c) => FIELD_BY_KEY.get(key(text(c))) ?? null);
  const errors: string[] = [];
  const files: Entry[] = [];
  rows.slice(headerIdx + 1).forEach((r, i) => {
    const raw: Partial<Record<keyof Entry, Cell>> = {};
    columns.forEach((field, ci) => {
      if (field && raw[field] === undefined) raw[field] = r[ci] ?? null;
    });
    const e = normalizeEntry(raw, headerIdx + i + 2, errors);
    if (e) files.push(e);
  });
  return finish(files, [], undefined, errors);
}

function fromJson(data: unknown): S['UploadManifest'] {
  const errors: string[] = [];
  let list: unknown[];
  let expected: S['ExpectedDocument'][] = [];
  let objectExternalId: string | undefined;
  if (Array.isArray(data)) list = data;
  else if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    list = (Array.isArray(obj.files) ? obj.files : Array.isArray(obj.registry) ? obj.registry : []) as unknown[];
    expected = Array.isArray(obj.expected) ? (obj.expected as S['ExpectedDocument'][]) : [];
    objectExternalId = typeof obj.object_external_id === 'string' ? obj.object_external_id : undefined;
  } else {
    throw badRequest('Реестр JSON должен быть объектом UploadManifest или массивом записей', undefined, 'REGISTRY_INVALID');
  }
  const files: Entry[] = [];
  list.forEach((item, i) => {
    if (!item || typeof item !== 'object') {
      errors.push(`запись ${i + 1}: ожидается объект`);
      return;
    }
    const raw: Partial<Record<keyof Entry, Cell>> = {};
    for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
      const field = FIELD_BY_KEY.get(key(k));
      if (field && raw[field] === undefined) raw[field] = (typeof v === 'object' ? null : v) as Cell;
    }
    const e = normalizeEntry(raw, i + 1, errors);
    if (e) files.push(e);
  });
  for (const [i, e] of expected.entries()) {
    const s = stageOf(String(e?.doc_stage ?? ''));
    if (!s) errors.push(`expected[${i}]: неизвестная стадия «${String(e?.doc_stage ?? '')}»`);
    else e.doc_stage = s;
  }
  return finish(files, expected, objectExternalId, errors);
}

function finish(files: Entry[], expected: S['ExpectedDocument'][], objectExternalId: string | undefined, errors: string[]): S['UploadManifest'] {
  const ids = new Map<string, number>();
  for (const f of files) if (f.file_id) ids.set(f.file_id, (ids.get(f.file_id) ?? 0) + 1);
  const dupIds = [...ids].filter(([, n]) => n > 1).map(([id]) => id);
  if (dupIds.length) errors.push(`file_id повторяется: ${dupIds.join(', ')}`);
  if (errors.length) {
    throw badRequest(`Реестр файлов содержит ошибки (${errors.length})`, { errors: errors.slice(0, 50) }, 'REGISTRY_INVALID');
  }
  if (files.length === 0 && expected.length === 0) {
    throw badRequest('Реестр файлов пуст', undefined, 'REGISTRY_INVALID');
  }
  const objectIds = [...new Set(files.map((f) => f.object_id).filter(Boolean))];
  return {
    object_external_id: objectExternalId ?? (objectIds.length === 1 ? objectIds[0] : undefined),
    files,
    expected,
  };
}

/** Разбор файла реестра по расширению (или содержимому для JSON). */
export function parseRegistry(buf: Buffer, fileName: string): ParsedRegistry {
  const ext = /\.([a-z]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  if (ext === 'xlsx' || (buf[0] === 0x50 && buf[1] === 0x4b)) {
    let rows: Cell[][];
    try {
      rows = readXlsxFirstSheet(buf);
    } catch (err) {
      throw badRequest(`Не удалось прочитать реестр XLSX: ${(err as Error).message}`, undefined, 'REGISTRY_INVALID');
    }
    return { format: 'XLSX', manifest: fromTable(rows) };
  }
  const textContent = buf.toString('utf8').replace(/^\uFEFF/, '');
  const lines = textContent.split(/\r?\n/).filter((l) => l.trim());
  // JSON Lines (document_manifest.jsonl организаторов): по объекту на строку
  if (ext === 'jsonl' || (lines.length > 1 && lines.every((l) => /^\s*\{.*\}\s*$/.test(l)))) {
    const items: unknown[] = [];
    for (const [i, line] of lines.entries()) {
      try {
        items.push(JSON.parse(line));
      } catch {
        throw badRequest(`Реестр JSONL: строка ${i + 1}, некорректный JSON`, undefined, 'REGISTRY_INVALID');
      }
    }
    return { format: 'JSON', manifest: fromJson(items) };
  }
  if (ext === 'json' || /^\s*[[{]/.test(textContent)) {
    let data: unknown;
    try {
      data = JSON.parse(textContent);
    } catch {
      throw badRequest('Реестр JSON не разобран: проверьте синтаксис', undefined, 'REGISTRY_INVALID');
    }
    return { format: 'JSON', manifest: fromJson(data) };
  }
  if (ext && ext !== 'csv' && ext !== 'txt') {
    throw badRequest('Реестр принимается в форматах CSV, XLSX, JSON или JSONL', undefined, 'REGISTRY_INVALID');
  }
  return { format: 'CSV', manifest: fromTable(parseCsvRows(textContent, detectDelimiter(textContent))) };
}

/** Реестр из JSON-строки поля manifest (формат UploadManifest) — те же нормализация и проверки. */
export function parseManifestJson(json: string): S['UploadManifest'] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw badRequest('Поле manifest должно быть JSON по схеме UploadManifest', undefined, 'REGISTRY_INVALID');
  }
  return fromJson(data);
}
