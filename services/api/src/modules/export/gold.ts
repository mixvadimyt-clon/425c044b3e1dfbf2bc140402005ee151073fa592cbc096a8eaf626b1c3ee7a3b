import type { Db } from '../../db/sqlite.js';
import type { S } from '../../types.js';
import type { ExportModel } from './report.js';

/**
 * Выгрузка по листу «СХЕМА GOLD» Приложения 1 (REQ-ML-08): запись на атомарный finding и гипотезу.
 * Параметры без finding для оценки (нет источников, неприменимо и т.п.) — в not_evaluated.
 * Она же — пример выходного JSON для сдачи.
 */

type GoldStatus = S['GoldRecord']['finding_status'];
const EVALUATED: Partial<Record<S['FindingStatus'], GoldStatus>> = {
  CANDIDATE: 'CANDIDATE',
  CONFIRMED_VIOLATION: 'CONFIRMED_VIOLATION',
  NEGATIVE_VERIFIED: 'NEGATIVE_VERIFIED',
};

function source(m: ExportModel, x: S['EvidenceFragment']): S['GoldSource'] {
  const file = m.files.get(x.file_id);
  return {
    file_id: file?.external_file_id ?? x.file_id,
    internal_file_id: x.file_id,
    sha256: x.sha256 ?? file?.sha256 ?? '',
    stage: x.stage,
    code: x.document_code ?? file?.document_code ?? null,
    revision: x.revision ?? file?.revision ?? null,
    approval: x.approval_status ?? file?.approval_status ?? 'UNKNOWN',
    page: x.page,
    sheet: x.sheet ?? null,
    bbox_polygon: x.polygon?.length ? x.polygon.flat() : x.bbox,
    value: x.normalized_value ?? x.extracted_value ?? null,
    source: x.source,
    extraction_method: x.extraction_method ?? null,
  };
}

/** Плоские поля source_{role}_* — первый фрагмент роли, как в схеме организаторов. */
function flat(prefix: 'source_expected' | 'source_actual', list: S['GoldSource'][]) {
  const f = list[0];
  return {
    [`${prefix}_file_id`]: f?.file_id ?? null,
    [`${prefix}_sha256`]: f?.sha256 ?? null,
    [`${prefix}_stage`]: f?.stage ?? null,
    [`${prefix}_code`]: f?.code ?? null,
    [`${prefix}_revision`]: f?.revision ?? null,
    [`${prefix}_approval`]: f?.approval ?? null,
    [`${prefix}_page`]: f?.page ?? null,
    [`${prefix}_bbox_polygon`]: f?.bbox_polygon ?? null,
  };
}

export function buildGold(db: Db, m: ExportModel): S['GoldExport'] {
  const p = m.protocol;
  const versions = { dataset_version: p.versions.dataset_version, matrix_version: p.versions.matrix_version, model_version: p.versions.model_version };
  const objectId = p.object.external_id ?? p.object.id;
  const splitOf = (checkId: string) =>
    db.get<{ split: string | null }>("SELECT split FROM dataset_items WHERE check_id = ? AND curation_status = 'APPROVED'", checkId)?.split ?? null;

  const findings = [...p.tables.candidates, ...p.tables.confirmed_violations, ...p.tables.negative_verified].filter(
    (f, i, all) => all.findIndex((x) => x.id === f.id) === i,
  );
  const records: S['GoldRecord'][] = [];
  for (const f of findings) {
    // CANDIDATE на уточнении остаётся кандидатом; полнота показывает, что нужно уточнить
    const status = EVALUATED[f.finding_status] ?? (f.finding_status === 'CLARIFICATION_REQUIRED' ? 'CANDIDATE' : undefined);
    if (!status) continue;
    const expected = f.evidence_group.fragments.filter((x) => x.role === 'EXPECTED').map((x) => source(m, x));
    const actual = f.evidence_group.fragments.filter((x) => x.role === 'ACTUAL').map((x) => source(m, x));
    const d = f.decision;
    records.push({
      evidence_group_id: f.evidence_group.id ?? f.finding_key,
      finding_id: f.finding_key,
      internal_id: f.id,
      object_id: objectId,
      matrix_code: f.param_code,
      rule_key: f.rule_key ?? null,
      rule_version: p.versions.matrix_version,
      expected_value: f.expected_value ?? null,
      actual_value: f.actual_value ?? null,
      unit: f.unit ?? null,
      ...flat('source_expected', expected),
      ...flat('source_actual', actual),
      source_expected: expected,
      source_actual: actual,
      approved_change_ref: d?.approved_change_ref ?? f.approved_change_ref ?? 'NONE',
      completeness_status: f.finding_status === 'CLARIFICATION_REQUIRED' ? 'CLARIFICATION_REQUIRED' : f.completeness_status,
      finding_status: status,
      review_priority: f.review_priority,
      rationale: f.rationale ?? null,
      expert_id: d?.user_id ?? null,
      expert_name: d?.user_name ?? null,
      expert_timestamp: d?.decided_at ?? null,
      expert_reason_code: d?.reason_code ?? null,
      expert_comment: d?.comment ?? null,
      ...versions,
      split: splitOf(f.id),
    });
  }

  for (const x of p.tables.suspicions) {
    if (x.inspector_status === 'PROMOTED') continue; // уже есть как кандидат
    const expected = (x.evidence ?? []).filter((e) => e.stage === 'PD').map((e) => source(m, e));
    const actual = (x.evidence ?? []).filter((e) => e.stage !== 'PD').map((e) => source(m, e));
    records.push({
      evidence_group_id: x.suspicion_key ?? x.suspicion_id,
      finding_id: x.suspicion_key ?? x.suspicion_id,
      internal_id: x.suspicion_id,
      object_id: objectId,
      matrix_code: null,
      rule_key: null,
      rule_version: `free-search:${x.discovery_method}@${p.versions.model_version}`,
      expected_value: x.pd_reference ?? null,
      actual_value: x.rd_reference ?? x.id_reference ?? null,
      unit: null,
      ...flat('source_expected', expected),
      ...flat('source_actual', actual),
      source_expected: expected,
      source_actual: actual,
      approved_change_ref: 'NONE',
      completeness_status: expected.length && actual.length ? 'COMPLETE' : 'MISSING_EVIDENCE',
      finding_status: 'SUSPICION',
      review_priority: x.review_priority,
      rationale: x.description,
      expert_id: null,
      expert_name: null,
      expert_timestamp: null,
      expert_reason_code: null,
      expert_comment: null,
      ...versions,
      split: null,
    });
  }

  const evaluated = new Set(findings.map((f) => f.id));
  const keyOf = new Map(findings.map((f) => [f.id, f]));
  const notEvaluated = p.tables.completeness
    .filter((r) => r.finding_id && !evaluated.has(r.finding_id))
    .map((r) => {
      const row = db.get<{ finding_key: string; rule_key: string | null; rationale: string | null }>(
        'SELECT finding_key, rule_key, rationale FROM checks WHERE id = ?',
        r.finding_id!,
      );
      return {
        finding_id: row?.finding_key ?? keyOf.get(r.finding_id!)?.finding_key ?? r.finding_id!,
        matrix_code: r.param_code,
        rule_key: row?.rule_key ?? null,
        completeness_status: r.completeness_status,
        finding_status: r.finding_status,
        missing_sources: r.missing_sources ?? [],
        rationale: row?.rationale ?? null,
      };
    });

  return {
    schema: 'inspector-gold/1.0',
    generated_at: m.generatedAt,
    protocol_id: p.id,
    protocol_version: p.version,
    protocol_status: p.status,
    process_id: p.process_id,
    object_id: objectId,
    object_name: p.object.name,
    input_manifest_hash: p.versions.input_manifest_hash,
    completeness: m.completeness,
    records,
    not_evaluated: notEvaluated,
  };
}
