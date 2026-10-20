import type { Db } from '../../db/sqlite.js';
import { parseJson } from '../../db/sqlite.js';
import type { DocStage, S } from '../../types.js';
import { mapFinding } from '../repo.js';
import type { ExportModel } from './report.js';

/**
 * Ответ участника в формате организаторов (submission_schema.json из датасета, data/samples/dataset-overview.md §4):
 * запись на атомарную проверку, код параметра — внешний (KR-055), location — rule_key,
 * доказательство — стадия, file_id из реестра и номер страницы PDF (bbox не оценивается).
 * Гипотезы свободного поиска выгружаются там же, в checks[], с кодом FREE-<ТЕМА>-<NNN> — как FREE-HEATING-001
 * в эталоне организаторов. Тема — по разделу документа-источника.
 */

type Label = S['SubmissionCheck']['violation_label'];
type ProtocolStatus = S['SubmissionCheck']['protocol_status'];

const LABEL: Partial<Record<S['FindingStatus'], Label>> = {
  CANDIDATE: 'VIOLATION_PRESENT',
  CONFIRMED_VIOLATION: 'VIOLATION_PRESENT',
  NEGATIVE_VERIFIED: 'NO_VIOLATION',
  MISSING_EVIDENCE: 'MISSING_DOCUMENT',
  NOT_COMPARABLE: 'COMPARISON_IMPOSSIBLE',
  CLARIFICATION_REQUIRED: 'COMPARISON_IMPOSSIBLE',
};

/** Критичность из каталога организаторов: HIGH ↔ «Критическое», MEDIUM ↔ «Существенное» (проверено на всех 132). */
const CRITICALITY: Partial<Record<S['ReviewPriority'], string>> = {
  HIGH: 'Критическое (приостановка работ)',
  MEDIUM: 'Существенное (предписание)',
};

const STAGES: DocStage[] = ['PD', 'RD', 'ID'];

/** Тема находки вне матрицы по марке или разделу документа-источника. */
const FREE_TOPIC: [RegExp, string][] = [
  [/^(ОВ|ИОС4|ТС|ИТП|ТМ)/, 'HEATING'],
  [/^(ВК|НВК|ИОС2|ИОС3|ВС|ВО|К\d)/, 'WATER'],
  [/^(ЭОМ|ЭС|ЭН|ЭМ|ЭО|ИОС1)/, 'POWER'],
  [/^(СС|СКС|ИОС5|АПС|СОУЭ|СКУД|АК)/, 'LOWCURRENT'],
  [/^(ГС|ГСН|ИОС6)/, 'GAS'],
  [/^(АР|АИ|АС)/, 'ARCH'],
  [/^(КР|КЖ|КМ|КД|КЖИ)/, 'STRUCT'],
  [/^(ГП|ПЗУ|СПЗУ|ТР|БЛ)/, 'SITE'],
  [/^(ПОС|ПОД)/, 'CONSTRUCTION'],
  [/^(ПБ|ППМ|МПБ|АУПТ)/, 'FIRE'],
];

export function freeTopic(discipline: string | null | undefined): string {
  const mark = (discipline ?? '').toUpperCase().replace(/[\s._-]+/g, '');
  return FREE_TOPIC.find(([re]) => re.test(mark))?.[1] ?? 'GENERAL';
}

const STAGE_BY_LABEL: Record<string, DocStage> = { ПД: 'PD', РД: 'RD', ИД: 'ID', PD: 'PD', RD: 'RD', ID: 'ID' };

/** Какой стадии не хватает: из missing_sources («РД: нет документов …»), иначе первая стадия без доказательств. */
function missingStage(missingSources: string[], present: Set<DocStage>): DocStage | null {
  for (const s of missingSources) {
    const stage = STAGE_BY_LABEL[s.split(':')[0].trim()];
    if (stage) return stage;
  }
  return STAGES.find((s) => !present.has(s)) ?? null;
}

function protocolStatus(label: Label, priority: S['ReviewPriority'], missing: DocStage | null): ProtocolStatus {
  if (label === 'NO_VIOLATION') return 'OK';
  if (label === 'VIOLATION_PRESENT') return priority === 'HIGH' ? 'CRITICAL' : 'WARNING';
  if (label === 'MISSING_DOCUMENT' && missing) return `${missing}_MISSING`;
  return 'COMPARISON_IMPOSSIBLE';
}

function evidenceOf(m: ExportModel, fragments: S['EvidenceFragment'][]): S['SubmissionEvidence'][] {
  const seen = new Set<string>();
  const evidence: S['SubmissionEvidence'][] = [];
  for (const x of [...fragments].sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage))) {
    const fileId = m.files.get(x.file_id)?.external_file_id ?? x.file_id;
    const key = `${x.stage}|${fileId}|${x.page}`;
    if (seen.has(key)) continue;
    seen.add(key);
    evidence.push({ stage: x.stage, file_id: fileId, pdf_page_number: x.page });
  }
  return evidence;
}

export function buildSubmission(db: Db, m: ExportModel, freeMinConfidence = 0.5): S['SubmissionExport'] {
  const p = m.protocol;
  const params = new Map(
    db
      .all<{ code: string; external_code: string | null; review_priority: S['ReviewPriority'] }>(
        'SELECT code, external_code, review_priority FROM params',
      )
      .map((r) => [r.code, r]),
  );
  const rows = db.all('SELECT * FROM checks WHERE protocol_id = ? AND is_split = 0 ORDER BY param_code, rule_key', p.id);

  const checks: S['SubmissionCheck'][] = [];
  for (const row of rows) {
    const f = mapFinding(db, row);
    const label = LABEL[f.finding_status];
    if (!label) continue; // NOT_APPLICABLE — не проверка
    const param = params.get(f.param_code);
    const priority = param?.review_priority ?? f.review_priority;
    const fragments = f.evidence_group.fragments;
    const present = new Set(fragments.map((x) => x.stage));
    const valueOf = (stage: DocStage) => {
      const x = fragments.find((fr) => fr.stage === stage);
      return x?.normalized_value ?? x?.extracted_value ?? (stage === 'PD' ? (f.expected_value ?? null) : null);
    };
    const evidence = evidenceOf(m, fragments);
    checks.push({
      parameter_code: param?.external_code ?? f.param_code,
      location: f.rule_key ?? null,
      pd_value: valueOf('PD'),
      rd_value: valueOf('RD'),
      id_value: valueOf('ID'),
      violation_label: label,
      protocol_status: protocolStatus(label, priority, missingStage(parseJson<string[]>(row.missing_sources, []), present)),
      criticality: CRITICALITY[priority] ?? null,
      evidence,
    });
  }
  // Свободный поиск: отклонённые инспектором и переведённые в кандидаты (они уже есть выше) не выгружаем
  const numbers = new Map<string, number>();
  const suspicions = p.tables.suspicions
    .filter((x) => x.inspector_status !== 'DISMISSED' && x.inspector_status !== 'PROMOTED' && x.confidence >= freeMinConfidence)
    .sort((a, b) => (a.suspicion_key ?? a.suspicion_id).localeCompare(b.suspicion_key ?? b.suspicion_id));
  for (const x of suspicions) {
    const evidence = x.evidence ?? [];
    const source = evidence.find((e) => e.stage === 'PD') ?? evidence[0];
    const topic = freeTopic(source ? m.files.get(source.file_id)?.discipline : null);
    const n = (numbers.get(topic) ?? 0) + 1;
    numbers.set(topic, n);
    const label: Label = x.inspector_status === 'CLARIFICATION_REQUIRED' ? 'COMPARISON_IMPOSSIBLE' : 'VIOLATION_PRESENT';
    checks.push({
      parameter_code: `FREE-${topic}-${String(n).padStart(3, '0')}`,
      location: null,
      pd_value: null,
      rd_value: null,
      id_value: null,
      violation_label: label,
      protocol_status: protocolStatus(label, x.review_priority, null),
      criticality: CRITICALITY[x.review_priority] ?? null,
      evidence: evidenceOf(m, evidence),
    });
  }
  return { object_id: p.object.external_id ?? p.object.id, checks };
}
