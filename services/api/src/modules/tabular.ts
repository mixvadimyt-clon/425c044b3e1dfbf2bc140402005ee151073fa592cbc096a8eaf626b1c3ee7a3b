import { strFromU8, unzipSync } from 'fflate';

/** Чтение табличных файлов (CSV, XLSX) без тяжёлых зависимостей: матрица и реестры файлов. */

export type Cell = string | number | boolean | null;

/** CSV по RFC 4180: кавычки, разделители и переводы строк внутри кавычек. Разделитель по умолчанию — запятая. */
export function parseCsvRows(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** CSV с заголовком → массив объектов. */
export function parseCsv(text: string, delimiter = ','): Record<string, string>[] {
  const [header, ...data] = parseCsvRows(text, delimiter);
  if (!header) return [];
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

/** Разделитель CSV по первой строке: «;» (Excel в русской локали), табуляция или запятая. */
export function detectDelimiter(text: string): string {
  const first = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
  const counts = [';', '\t', ','].map((d) => [d, first.split(d).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });
}

/** Текст элемента с учётом rich text (несколько <t> внутри <si>/<is>). */
function textOf(xml: string): string {
  return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join('');
}

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Первый лист XLSX как массив строк. Числа остаются числами (даты Excel — порядковые номера дней,
 * см. excelSerialToIsoDate), формулы — последним вычисленным значением.
 */
export function readXlsxFirstSheet(buf: Uint8Array): Cell[][] {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(buf, { filter: (f) => f.name.startsWith('xl/') });
  } catch {
    throw new Error('Файл не является корректным XLSX');
  }
  const read = (name: string) => (entries[name] ? strFromU8(entries[name]) : null);
  const workbook = read('xl/workbook.xml');
  if (!workbook) throw new Error('В XLSX нет xl/workbook.xml');
  const firstSheet = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1];
  const rels = read('xl/_rels/workbook.xml.rels') ?? '';
  let target = 'worksheets/sheet1.xml';
  if (firstSheet) {
    const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((r) => r.includes(`Id="${firstSheet}"`));
    const t = rel && /Target="([^"]+)"/.exec(rel)?.[1];
    if (t) target = t.replace(/^\/?xl\//, '').replace(/^\//, '');
  }
  const sheet = read(`xl/${target}`);
  if (!sheet) throw new Error(`В XLSX нет листа ${target}`);
  const shared = [...(read('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));

  const rows: Cell[][] = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const row: Cell[] = [];
    for (const cm of (rm[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const body = cm[2] ?? '';
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const type = /\bt="(\w+)"/.exec(attrs)?.[1] ?? 'n';
      const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value: Cell = null;
      if (type === 's') value = raw !== undefined ? (shared[Number(raw)] ?? null) : null;
      else if (type === 'inlineStr') value = textOf(body);
      else if (type === 'str' || type === 'e') value = raw !== undefined ? decodeXml(raw) : null;
      else if (type === 'b') value = raw === '1';
      else value = raw !== undefined && raw !== '' ? Number(raw) : null;
      const idx = ref ? columnIndex(ref) : row.length;
      while (row.length < idx) row.push(null);
      row[idx] = value;
    }
    rows.push(row);
  }
  return rows;
}

/** Порядковый номер дня Excel (система 1900) → YYYY-MM-DD. */
export function excelSerialToIsoDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000); // 25569 — 1970-01-01
  return new Date(ms).toISOString().slice(0, 10);
}
