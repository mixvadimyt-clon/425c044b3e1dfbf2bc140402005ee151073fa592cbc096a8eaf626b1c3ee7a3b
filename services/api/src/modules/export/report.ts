import type { Db } from '../../db/sqlite.js';
import { nowIso, parseJson } from '../../db/sqlite.js';
import type { S } from '../../types.js';
import { completenessSummary, getProtocol, listFiles } from '../repo.js';
import {
  APPROVAL,
  COMPLETENESS,
  FINDING,
  INSPECTOR,
  ISSUE,
  METHOD,
  PRIORITY,
  PROTOCOL_STATUS,
  REASON,
  SCENARIO,
  STAGE,
  SUSPICION_STATUS,
  TRIGGER,
  dash,
  formatDateTime,
  uploadLabel,
} from './labels.js';

/**
 * Данные для всех форматов экспорта: протокол, полнота комплекта и файлы проверки.
 * Текущая версия — с живым состоянием комплекта; прежняя — со снимком на момент её сравнения.
 */
export interface ExportModel {
  protocol: S['Protocol'];
  completeness: S['CompletenessSummary'];
  files: Map<string, S['FileInfo']>;
  generatedAt: string;
}

export function loadExportModel(db: Db, protocolId: string): ExportModel {
  const protocol = getProtocol(db, protocolId);
  const files = new Map(listFiles(db, protocol.process_id).map((f) => [f.id, f]));
  let completeness = completenessSummary(db, protocol.process_id);
  if (!protocol.is_current) {
    const row = db.get<{ snapshot: string }>('SELECT snapshot FROM protocols WHERE id = ?', protocolId);
    const snapshot = parseJson<{ completeness?: S['CompletenessSummary'] }>(row?.snapshot, {});
    if (snapshot.completeness) completeness = snapshot.completeness;
    for (const f of protocol.input_files) files.set(f.id, f);
  }
  return { protocol, completeness, files, generatedAt: nowIso() };
}

/**
 * Печатная форма протокола (REQ-CMP-08), общая для PDF и DOCX: шапка, статусы загрузки, реестр файлов,
 * сводка, 5 таблиц и перечень недостающих доказательств (REQ-VER-07). Форма уточнится по Приложению 2.
 */
export interface ReportTable {
  kind: 'table';
  title: string;
  note?: string;
  columns: { title: string; width: number }[];
  rows: string[][];
  empty: string;
}
export interface ReportFacts {
  kind: 'facts';
  title: string;
  items: [string, string][];
}
export interface ReportList {
  kind: 'list';
  title: string;
  items: string[];
  empty: string;
}
export type ReportSection = ReportTable | ReportFacts | ReportList;

export interface Report {
  title: string;
  subtitle: string;
  sections: ReportSection[];
  signature: { inspector: string; date: string };
  footer: string;
}

const paramTitle = (f: { param_code: string; param_name?: string; rule_key?: string | null }) =>
  [f.param_name, f.rule_key].filter(Boolean).join(' — ') || f.param_code;

/** Единицу пишем только к числам: у классов и марок единица матрицы — это название шкалы («Марка (B)»). */
function withUnit(value: string | null | undefined, unit: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const numeric = /^[-+−]?\d[\d\s]*([.,]\d+)?$/.test(value.trim());
  return unit && numeric ? `${value} ${unit}` : value;
}

/** Замечания одного вида схлопываем, если их больше трёх: иначе 19 дубликатов занимают страницу. */
function issueLines(issues: S['RegistryIssue'][]): string[] {
  const byCode = new Map<S['RegistryIssueCode'], S['RegistryIssue'][]>();
  for (const i of issues) byCode.set(i.code, [...(byCode.get(i.code) ?? []), i]);
  const target = (i: S['RegistryIssue']) => (i.file_name ? `${i.file_name}${i.external_file_id ? ` (${i.external_file_id})` : ''}` : (i.external_file_id ?? ''));
  return [...byCode].flatMap(([code, list]) => {
    if (list.length <= 3) return list.map((i) => `${i.message}${target(i) ? `: ${target(i)}` : ''}`);
    const names = list.map(target).filter(Boolean);
    const shown = names.slice(0, 5).join('; ');
    return [`${ISSUE[code][0].toUpperCase()}${ISSUE[code].slice(1)}, ${list.length}: ${shown}${names.length > 5 ? ` и ещё ${names.length - 5}` : ''}. ${list[0].message}`];
  });
}

export function describeFragment(files: Map<string, S['FileInfo']>, x: S['EvidenceFragment']): string {
  const file = files.get(x.file_id);
  const doc = x.document_code ?? file?.document_code ?? file?.original_name ?? x.file_id;
  const rev = x.revision ?? file?.revision;
  const sheet = x.sheet && x.sheet !== String(x.page) ? `, лист ${x.sheet}` : '';
  const ext = file?.external_file_id ? ` [${file.external_file_id}]` : '';
  return `${STAGE[x.stage]} ${doc}${rev ? `, изм. ${rev}` : ''}, стр. ${x.page}${sheet}${ext}`;
}

const sources = (m: ExportModel, f: S['Finding']) =>
  f.evidence_group.fragments.map((x) => `${x.role === 'EXPECTED' ? 'эталон' : x.role === 'ACTUAL' ? 'факт' : 'контекст'}: ${describeFragment(m.files, x)}`).join('\n') ||
  '—';

function decisionText(f: S['Finding']): string {
  const d = f.decision;
  if (!d) return INSPECTOR[f.inspector_status];
  const reason = d.reason_code ? `, ${REASON[d.reason_code as S['ReasonCode']] ?? d.reason_code}` : '';
  return `${INSPECTOR[d.resulting_status]}${reason}\n${dash(d.user_name)}, ${formatDateTime(d.decided_at)}${d.comment ? `\n«${d.comment}»` : ''}`;
}

export function buildReport(m: ExportModel): Report {
  const p = m.protocol;
  const o = p.object;
  const c = m.completeness;
  const t = p.tables;
  const s = p.summary;

  const header: ReportFacts = {
    kind: 'facts',
    title: 'Сведения о проверке',
    items: [
      ['Объект', o.name],
      ['Адрес', dash(o.address)],
      ['Идентификатор объекта', dash(o.external_id)],
      ['Застройщик (заказчик)', dash(o.customer)],
      ['Подрядчик', dash(o.contractor)],
      ['Разрешение на строительство', dash(o.permit_number)],
      ['Проверка', p.process_id],
      ['Версия протокола', `${p.version} (${TRIGGER[p.trigger ?? 'INITIAL']}), ${PROTOCOL_STATUS[p.status]}`],
      ['Сформирован', formatDateTime(p.created_at)],
      ['Финализирован', formatDateTime(p.finalized_at)],
      ['Инспектор', p.inspector?.full_name ?? '—'],
      ['Версии', `матрица ${p.versions.matrix_version}, модель ${p.versions.model_version}, датасет ${p.versions.dataset_version}`],
      ['Хеш входного набора', p.versions.input_manifest_hash],
    ],
  };

  const loading: ReportFacts = {
    kind: 'facts',
    title: 'Статус загрузки документов и тип проверки',
    items: [
      ['Статус загрузки', p.upload_status.map(uploadLabel).join('; ')],
      ['Тип проверки', SCENARIO[p.scenario]],
      ['Полнота комплекта', `${COMPLETENESS[c.status]}. ${dash(c.note)}`],
      ['Реестр файлов', c.registry === 'PRESENT' ? `${dash(c.registry_file_name)}, загружен ${formatDateTime(c.registry_uploaded_at)}` : 'не загружен'],
      ['Ожидалось / загружено', c.basis === 'MANIFEST' ? `${c.expected_total ?? 0} / ${c.present_total ?? 0}` : 'ожидаемый состав не задан'],
    ],
  };

  const issues: ReportList = {
    kind: 'list',
    title: 'Замечания по комплекту',
    items: issueLines(c.issues),
    empty: 'Замечаний нет',
  };

  const register: ReportTable = {
    kind: 'table',
    title: 'Реестр входных файлов',
    columns: [
      { title: '№', width: 3 },
      { title: 'ID файла', width: 11 },
      { title: 'Файл', width: 24 },
      { title: 'Стадия', width: 5 },
      { title: 'Шифр', width: 16 },
      { title: 'Изм.', width: 4 },
      { title: 'Статус утверждения', width: 10 },
      { title: 'SHA-256', width: 27 },
    ],
    rows: p.input_files.map((f, i) => [
      String(i + 1),
      dash(f.external_file_id),
      f.original_name,
      f.doc_stage ? STAGE[f.doc_stage] : '—',
      dash(f.document_code),
      dash(f.revision),
      APPROVAL[f.approval_status ?? 'UNKNOWN'],
      f.sha256,
    ]),
    empty: 'Файлов нет',
  };

  const summary: ReportFacts = {
    kind: 'facts',
    title: 'Сводка',
    items: [
      ['Параметров проверено', String(s.params_total ?? 0)],
      ['Кандидатов (ожидают решения)', `${s.candidates ?? 0} (${s.candidates_pending ?? 0})`],
      ['Подтверждённых нарушений', String(s.confirmed_violations ?? 0)],
      ['Проверенных отрицательных', String(s.negative_verified ?? 0)],
      ['Недостаточно доказательств / неприменимо / несопоставимо / на уточнении', `${s.missing_evidence ?? 0} / ${s.not_applicable ?? 0} / ${s.not_comparable ?? 0} / ${s.clarification_required ?? 0}`],
      ['Гипотез', String(s.suspicions ?? 0)],
      ['Соответствие', s.compliance_percent === null || s.compliance_percent === undefined ? '—' : `${s.compliance_percent} %`],
    ],
  };

  const byId = new Map([...t.candidates, ...t.confirmed_violations, ...t.negative_verified].map((f) => [f.id, f]));
  const completenessTable: ReportTable = {
    kind: 'table',
    title: '1. Комплектность и сопоставимость',
    columns: [
      { title: 'Код', width: 7 },
      { title: 'Параметр', width: 25 },
      { title: 'Полнота', width: 13 },
      { title: 'Результат', width: 15 },
      { title: 'Стадии', width: 8 },
      { title: 'Недостающие источники, комментарий', width: 32 },
    ],
    rows: t.completeness.map((r) => [
      r.param_code,
      [r.param_name, byId.get(r.finding_id ?? '')?.rule_key].filter(Boolean).join(' — ') || r.param_code,
      COMPLETENESS[r.completeness_status],
      FINDING[r.finding_status],
      (r.stages_present ?? []).map((x) => STAGE[x]).join(', ') || '—',
      [...(r.missing_sources ?? []), r.comment].filter(Boolean).join('\n') || '—',
    ]),
    empty: 'Параметры не проверялись',
  };

  const candidates: ReportTable = {
    kind: 'table',
    title: '2. Предварительные кандидаты',
    note: 'Кандидат ещё не нарушение: решение принимает инспектор. Приоритет определяет только очерёдность проверки.',
    columns: [
      { title: 'Код', width: 6 },
      { title: 'Параметр / элемент', width: 16 },
      { title: 'Эталон (ПД)', width: 9 },
      { title: 'Факт', width: 9 },
      { title: 'Отклонение', width: 8 },
      { title: 'Источники', width: 24 },
      { title: 'Обоснование', width: 14 },
      { title: 'Решение', width: 14 },
    ],
    rows: t.candidates.map((f) => [
      `${f.param_code}\n${PRIORITY[f.review_priority]}`,
      paramTitle(f),
      withUnit(f.expected_value, f.unit),
      withUnit(f.actual_value, f.unit),
      dash(f.delta),
      sources(m, f),
      dash(f.rationale),
      decisionText(f),
    ]),
    empty: 'Кандидатов нет',
  };

  const confirmed: ReportTable = {
    kind: 'table',
    title: '3. Подтверждённые нарушения',
    columns: [
      { title: 'Код', width: 6 },
      { title: 'Параметр / элемент', width: 18 },
      { title: 'Эталон (ПД)', width: 10 },
      { title: 'Факт', width: 10 },
      { title: 'Источники', width: 26 },
      { title: 'Норматив, согласованное изменение', width: 12 },
      { title: 'Решение инспектора', width: 18 },
    ],
    rows: t.confirmed_violations.map((f) => [
      f.param_code,
      paramTitle(f),
      withUnit(f.expected_value, f.unit),
      withUnit(f.actual_value, f.unit),
      sources(m, f),
      [f.normative_reference, f.approved_change_ref ? `изменение: ${f.approved_change_ref}` : null].filter(Boolean).join('\n') || '—',
      decisionText(f),
    ]),
    empty: 'Подтверждённых нарушений нет',
  };

  const negative: ReportTable = {
    kind: 'table',
    title: '4. Проверенные отрицательные результаты',
    columns: [
      { title: 'Код', width: 6 },
      { title: 'Параметр / элемент', width: 20 },
      { title: 'Эталон (ПД)', width: 10 },
      { title: 'Факт', width: 10 },
      { title: 'Источники', width: 28 },
      { title: 'Основание', width: 26 },
    ],
    rows: t.negative_verified.map((f) => [
      f.param_code,
      paramTitle(f),
      withUnit(f.expected_value, f.unit),
      withUnit(f.actual_value, f.unit),
      sources(m, f),
      f.decision ? `Решение инспектора: ${decisionText(f)}` : `Автоматически: ${dash(f.rationale)}`,
    ]),
    empty: 'Нет',
  };

  const suspicions: ReportTable = {
    kind: 'table',
    title: '5. Гипотезы свободного поиска',
    note: 'Гипотеза: повод для проверки, а не нарушение. Ищутся только расхождения между ПД, РД и ИД.',
    columns: [
      { title: 'Метод', width: 10 },
      { title: 'Описание', width: 30 },
      { title: 'ПД', width: 13 },
      { title: 'РД', width: 13 },
      { title: 'ИД', width: 10 },
      { title: 'Уверенность', width: 8 },
      { title: 'Статус', width: 12 },
    ],
    rows: t.suspicions.map((x) => [
      `${METHOD[x.discovery_method]}\n${PRIORITY[x.review_priority]}`,
      x.description,
      dash(x.pd_reference),
      dash(x.rd_reference),
      dash(x.id_reference),
      `${Math.round(x.confidence * 100)} %`,
      SUSPICION_STATUS[x.inspector_status],
    ]),
    empty: 'Гипотез нет',
  };

  const missing: ReportList = {
    kind: 'list',
    title: 'Что нужно запросить или дозагрузить',
    items: [
      ...c.missing.map((e) => `${STAGE[e.doc_stage]}: ${[e.discipline, e.document_code, e.file_name, e.title].filter(Boolean).join(', ')}`),
      ...t.completeness
        .filter((r) => r.finding_status === 'MISSING_EVIDENCE')
        .map((r) => `${r.param_code} ${dash(r.param_name)}: ${(r.missing_sources ?? []).join('; ') || 'источник не найден'}`),
    ],
    empty: 'Все необходимые документы загружены',
  };

  const inspector = p.inspector?.full_name ?? '';
  return {
    title: 'Протокол автоматизированной сверки проектной, рабочей и исполнительной документации',
    subtitle: `${o.name} · версия ${p.version} · ${formatDateTime(p.created_at)}`,
    sections: [header, loading, issues, register, summary, completenessTable, candidates, confirmed, negative, suspicions, missing],
    signature: { inspector, date: formatDateTime(p.finalized_at ?? m.generatedAt) },
    footer: `«Инспектор ИИ» · проверка ${p.process_id} · протокол v${p.version} · выгружен ${formatDateTime(m.generatedAt)}`,
  };
}
