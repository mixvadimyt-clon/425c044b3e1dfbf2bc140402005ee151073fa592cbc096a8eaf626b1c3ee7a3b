import type { DocStage, S } from '../types.js';

/**
 * Предварительная (до ML) оценка стадии/марки по имени файла.
 * Нужна для статусов загрузки сразу после upload; после парсинга ML уточняет метаданные.
 * Проверено на именах датасета: «4. Раздел 4 ЖС-РД-270121-П-КР 2024.pdf», «П-2025-04-266-КЖ01 11.11.2025.pdf»,
 * «РД-2025-04-266-АР1.pdf», «5.1.П-2025-04.266-ИОС1.2-ИТП.ЭОМ (1).pdf».
 */
const ID_KEYWORDS = /(аоср|исполнител|исп\.?\s*схем|журнал|акт\s|акт_|освидетельств|паспорт|сертификат)/i;
const PD_SECTIONS = ['ПЗ', 'ОПЗ', 'ПЗУ', 'СПОЗУ', 'ПОС', 'ПОД', 'ООС', 'ПБ', 'ППМ', 'ОДИ', 'ЭЭ', 'БЭО', 'ТБЭО', 'ПГМ', 'СМ'];
const RD_MARKS = ['КЖ', 'КМ', 'КМД', 'КД', 'ВК', 'НВК', 'ОВ', 'ТМ', 'ЭОМ', 'ЭМ', 'ЭО', 'ЭН', 'СС', 'АПС', 'СОУЭ', 'ГП', 'АС', 'АИ'];
const WEAK_PD = ['АР', 'КР', 'ТХ'];

export function stripName(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/, '') // расширение
    .replace(/^\s*\d+(\.\d+)*\.?\s*/, '') // «5.1.» / «4. »
    .trim();
}

function tokens(name: string): string[] {
  return name.split(/[^0-9A-Za-zА-Яа-яЁё]+/).filter(Boolean);
}

const upper = (t: string) => t.toUpperCase().replace(/Ё/g, 'Е');
const markOf = (t: string) => upper(t).replace(/\d+$/, '');

export function guessStage(fileName: string): DocStage | null {
  const name = stripName(fileName);
  if (ID_KEYWORDS.test(name)) return 'ID';
  const toks = tokens(name);
  const up = toks.map(upper);
  if (up.includes('РАЗДЕЛ')) return 'PD';
  if (up.some((t) => t.startsWith('ИОС'))) return 'PD';
  if (up.some((t) => PD_SECTIONS.includes(t))) return 'PD';
  // «-П-» как отметка стадии; первый токен «П-2025-…» — это номер проекта, не стадия
  if (up.slice(1).includes('П')) return 'PD';
  if (up.some((t) => RD_MARKS.includes(markOf(t)) && t !== 'РД')) return 'RD';
  if (up.some((t) => /^(АР|КР)\d+$/.test(t))) return 'RD';
  if (up[0] === 'РД' || up[0] === 'Р') return 'RD';
  if (up.some((t) => WEAK_PD.includes(t))) return 'PD';
  return null;
}

export function guessDiscipline(fileName: string): string | null {
  const up = tokens(stripName(fileName)).map(upper);
  const ios = up.find((t) => /^ИОС\d/.test(t));
  if (ios) return ios.slice(0, 4); // ИОС5.5.1 → ИОС5
  for (const t of up) {
    const m = markOf(t);
    if (m === 'СПОЗУ') return 'ПЗУ';
    if ([...PD_SECTIONS, ...RD_MARKS, ...WEAK_PD].includes(m) && m !== 'РД') return m;
  }
  return null;
}

export function guessRevision(fileName: string): string | null {
  const m = /изм\.?\s*(\d+)/i.exec(fileName);
  return m ? m[1] : null;
}

export function guessDocumentCode(fileName: string): string | null {
  const name = stripName(fileName).replace(/\s*\(\d+\)/g, '');
  const m = /(\p{Lu}{1,3}[-_][\p{L}\p{N}_.\-]*\d[\p{L}\p{N}_.\-]*)/u.exec(name);
  return m ? m[1].replace(/_/g, '-').replace(/[.\-]+$/, '') : name || null;
}

export interface StageFile {
  stage: DocStage | null;
  processing_status: string;
  id?: string;
  original_name?: string;
  document_code?: string | null;
  discipline?: string | null;
  sha256?: string;
  in_registry?: boolean;
  registry_key?: string | null;
  registry_sha256?: string | null;
  external_file_id?: string | null;
  external_predecessor_id?: string | null;
  duplicate_of?: string | null;
  approval_status?: string | null;
  predecessor_id?: string | null;
  is_authoritative?: boolean | null;
}

export interface ExpectedDoc {
  doc_stage: DocStage | null;
  discipline?: string | null;
  document_code?: string | null;
  file_name?: string | null;
  title?: string | null;
  /** Для строк реестра: файл считается загруженным, если занял эту строку (registry_key). */
  registry_key?: string | null;
  external_file_id?: string | null;
}

export interface RegistryState {
  present: boolean;
  file_name?: string | null;
  uploaded_at?: string | null;
  entries: S['ManifestFile'][];
}

type ManifestFile = S['ManifestFile'];
/** Ключ строки реестра — по нему файл «занимает» строку (и видно, какие строки не загружены). */
export const entryKey = (e: ManifestFile): string => (e.file_id ? `id:${e.file_id}` : e.file_name ? `name:${e.file_name}` : `sha:${e.sha256}`);

const norm = (v: string | null | undefined) => (v ?? '').toUpperCase().replace(/[\s_]+/g, '-').replace(/Ё/g, 'Е');
const usable = (f: StageFile) => f.processing_status !== 'FAILED' && f.processing_status !== 'REJECTED';

/** Ожидаемый документ считается загруженным, если есть файл той же стадии с тем же именем, шифром или маркой. */
export function isExpectedPresent(e: ExpectedDoc, files: StageFile[]): boolean {
  return files.some((f) => {
    if (!usable(f)) return false;
    if (e.registry_key) return f.registry_key === e.registry_key;
    if (f.stage !== e.doc_stage) return false;
    if (e.file_name) return f.original_name === e.file_name;
    if (e.document_code) return norm(f.document_code).includes(norm(e.document_code));
    if (e.discipline) return norm(f.discipline) === norm(e.discipline);
    return true;
  });
}

export interface Completeness {
  status: S['CompletenessStatus'];
  registry: S['RegistryStatus'];
  registry_file_name: string | null;
  registry_uploaded_at: string | null;
  upload_status: S['StageUploadStatus'][];
  basis: 'MANIFEST' | 'NONE';
  expected_total: number;
  present_total: number;
  missing: ExpectedDoc[];
  issues: S['RegistryIssue'][];
  /** Известный пробел: не хватает ожидаемых документов или файлы не обработались → PARTIALLY_LOADED. */
  known_gap: boolean;
  note: string;
}

const EXCLUDED_APPROVAL = ['SUPERSEDED', 'CANCELLED'];
const REFERENCE_APPROVAL = ['APPROVED', 'FOR_CONSTRUCTION'];
const BLOCKING: S['RegistryIssueCode'][] = ['NO_REGISTRY', 'NOT_IN_REGISTRY', 'SHA256_MISMATCH', 'AMBIGUOUS_REVISION'];

/**
 * Несколько действующих редакций одного документа без однозначного выбора («Перечень ИД» ред. 1.1):
 * выбор однозначен, если инспектор отметил ровно одну авторитетную или утверждена ровно одна.
 */
export function ambiguousRevisions(files: StageFile[]): StageFile[][] {
  const replaced = new Set(files.map((f) => f.predecessor_id).filter(Boolean));
  const groups = new Map<string, StageFile[]>();
  for (const f of files) {
    if (!usable(f) || f.duplicate_of || !f.stage || !f.document_code) continue;
    const excluded = EXCLUDED_APPROVAL.includes(f.approval_status ?? '') || (f.id !== undefined && replaced.has(f.id));
    if (f.is_authoritative === false || (excluded && f.is_authoritative !== true)) continue;
    const key = `${f.stage}|${norm(f.document_code)}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  return [...groups.values()].filter((g) => {
    if (g.length < 2) return false;
    if (g.filter((f) => f.is_authoritative === true).length === 1) return false;
    return g.filter((f) => REFERENCE_APPROVAL.includes(f.approval_status ?? '')).length !== 1;
  });
}

/**
 * Полнота комплекта (REQ-UPL-09, «Перечень ИД» ред. 1.1).
 * Статусы по стадиям:
 * - X_MISSING — файлов стадии нет;
 * - X_UPLOADED — только если есть ожидаемый состав (реестр/манифест) и он загружен полностью;
 * - X_PARTIAL — всё остальное: без реестра система не вправе объявить комплект полным.
 * Итог по комплекту — худший из: CLARIFICATION_REQUIRED → NOT_COMPARABLE → MISSING_EVIDENCE → COMPLETE.
 */
export function computeCompleteness(files: StageFile[], extraExpected: ExpectedDoc[], registry?: RegistryState): Completeness {
  const reg: RegistryState = registry ?? { present: false, entries: [] };
  const expected: ExpectedDoc[] = [
    ...reg.entries.map((e) => ({
      doc_stage: e.doc_stage ?? null,
      discipline: e.discipline ?? null,
      document_code: e.document_code ?? null,
      file_name: e.file_name ?? null,
      title: e.title ?? null,
      registry_key: entryKey(e),
      external_file_id: e.file_id ?? null,
    })),
    ...extraExpected,
  ];
  const missing = expected.filter((e) => !isExpectedPresent(e, files));
  const failed = files.filter((f) => f.processing_status === 'FAILED');
  const upload_status = (['PD', 'RD', 'ID'] as const).map((stage) => {
    const ofStage = files.filter((f) => f.stage === stage && f.processing_status !== 'REJECTED');
    if (ofStage.length === 0) return `${stage}_MISSING` as S['StageUploadStatus'];
    const exp = expected.filter((e) => e.doc_stage === stage);
    const broken = ofStage.some((f) => f.processing_status === 'FAILED');
    const complete = exp.length > 0 && !broken && exp.every((e) => isExpectedPresent(e, files));
    return `${stage}_${complete ? 'UPLOADED' : 'PARTIAL'}` as S['StageUploadStatus'];
  });

  const issues: S['RegistryIssue'][] = [];
  const issue = (code: S['RegistryIssueCode'], message: string, f?: StageFile | ExpectedDoc) =>
    issues.push({
      code,
      message,
      file_id: f && 'id' in f ? (f.id ?? null) : null,
      external_file_id: f?.external_file_id ?? null,
      file_name: f ? ((f as StageFile).original_name ?? (f as ExpectedDoc).file_name ?? null) : null,
    });
  const live = files.filter((f) => f.processing_status !== 'REJECTED');
  if (!reg.present) {
    issue('NO_REGISTRY', 'Реестр файлов не загружен, комплект принят со статусом CLARIFICATION_REQUIRED. Загрузите реестр (CSV, XLSX или JSON).');
  } else {
    for (const f of live.filter((x) => !x.in_registry && !x.duplicate_of)) issue('NOT_IN_REGISTRY', 'Файла нет в реестре комплекта', f);
    for (const f of live.filter((x) => x.in_registry && x.registry_sha256 && x.sha256 && x.registry_sha256 !== x.sha256)) {
      issue('SHA256_MISMATCH', 'Контрольная сумма файла не совпадает с реестром', f);
    }
    for (const e of missing.filter((x) => x.registry_key)) issue('MISSING_FILE', 'Файл из реестра не загружен', e);
    const known = new Set([...reg.entries.map((e) => e.file_id), ...files.map((f) => f.external_file_id)].filter(Boolean));
    for (const f of live.filter((x) => x.external_predecessor_id && !known.has(x.external_predecessor_id))) {
      issue('UNKNOWN_LINK', `Предыдущая редакция ${f.external_predecessor_id} не найдена в комплекте`, f);
    }
  }
  for (const g of ambiguousRevisions(files)) {
    issue(
      'AMBIGUOUS_REVISION',
      `Несколько редакций «${g[0].document_code}» без однозначного статуса: ${g.map((f) => f.original_name).join(', ')}. Выберите авторитетную редакцию.`,
      g[0],
    );
  }
  for (const f of failed) issue('UNREADABLE_FILE', 'Файл не удалось обработать, нужна замена', f);
  for (const f of live.filter((x) => x.duplicate_of)) issue('DUPLICATE_CONTENT', 'Повторная загрузка того же содержимого, в сравнение не идёт', f);
  for (const f of live.filter((x) => x.processing_status === 'SKIPPED')) issue('FORMAT_CARD_ONLY', 'Формат без анализа (архив, DWG и т.п.): файл в комплекте, но не сравнивается', f);

  const codes = new Set(issues.map((i) => i.code));
  const status: S['CompletenessStatus'] = BLOCKING.some((c) => codes.has(c))
    ? 'CLARIFICATION_REQUIRED'
    : codes.has('UNREADABLE_FILE')
      ? 'NOT_COMPARABLE'
      : missing.length > 0
        ? 'MISSING_EVIDENCE'
        : 'COMPLETE';
  const basis = expected.length > 0 ? 'MANIFEST' : 'NONE';
  const notes: Record<S['CompletenessStatus'], string> = {
    CLARIFICATION_REQUIRED: reg.present
      ? 'Комплект требует уточнения: есть расхождения с реестром или неоднозначные редакции'
      : 'Реестр файлов не загружен: полнота не подтверждена, комплект требует уточнения',
    NOT_COMPARABLE: 'Часть файлов не читается, нужна замена',
    MISSING_EVIDENCE: `Не хватает документов: ${missing.length} из ${expected.length}`,
    COMPLETE: 'Все документы из реестра загружены',
    NOT_APPLICABLE: '',
  };
  return {
    status,
    registry: reg.present ? 'PRESENT' : 'ABSENT',
    registry_file_name: reg.file_name ?? null,
    registry_uploaded_at: reg.uploaded_at ?? null,
    upload_status,
    basis,
    expected_total: expected.length,
    present_total: expected.length - missing.length,
    missing,
    issues,
    known_gap: missing.length > 0 || failed.length > 0,
    note: notes[status],
  };
}

/** Упрощённый вариант без реестра (для заглушки ML и тестов). */
export function computeUploadStatus(files: StageFile[]): S['StageUploadStatus'][] {
  return computeCompleteness(files, []).upload_status;
}

const RANK: Record<string, number> = { MISSING: 2, PARTIAL: 1, UPLOADED: 0 };
/** Итоговый статус стадии — худший из оценки api (манифест) и движка сравнения (источники параметров). */
export function mergeUploadStatus(a: S['StageUploadStatus'][], b: S['StageUploadStatus'][] | undefined): S['StageUploadStatus'][] {
  if (!b?.length) return a;
  return a.map((s) => {
    const stage = s.slice(0, 2);
    const other = b.find((x) => x.startsWith(stage));
    if (!other) return s;
    return RANK[other.slice(3)] > RANK[s.slice(3)] ? other : s;
  });
}

/** Сценарий по составу стадий (docs/domain/statuses.md §3); PARTIALLY_LOADED — только при известном пробеле. */
export function computeScenario(uploadStatus: S['StageUploadStatus'][], knownGap = false): S['CheckScenario'] | null {
  const present = uploadStatus.filter((s) => !s.endsWith('_MISSING')).map((s) => s.slice(0, 2));
  if (present.length === 0) return null;
  if (knownGap) return 'PARTIALLY_LOADED';
  switch (present.sort().join('+')) {
    case 'ID+PD+RD':
      return 'FULL';
    case 'PD+RD':
      return 'PD_RD_ONLY';
    case 'ID+PD':
      return 'PD_ID_ONLY';
    case 'ID+RD':
      return 'RD_ID_ONLY';
    default:
      return 'SINGLE_ONLY';
  }
}
