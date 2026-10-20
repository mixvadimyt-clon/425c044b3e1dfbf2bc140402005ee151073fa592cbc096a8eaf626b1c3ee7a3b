import type { S } from '../../types.js';
import type { ExportModel } from './report.js';

/** XML протокола для внешних ИС: та же структура, что и JSON (Protocol), плюс полнота комплекта. */

type Attrs = Record<string, string | number | boolean | null | undefined>;
type Node = string | null | undefined | false | Node[];

const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => escText(s).replace(/"/g, '&quot;').replace(/\r?\n/g, '&#10;');
// символы, запрещённые в XML 1.0 (могут прийти из текстового слоя PDF)
const clean = (s: string) => s.replace(/[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '');

function el(name: string, attrs: Attrs = {}, ...children: Node[]): string {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => ` ${k}="${escAttr(clean(String(v)))}"`)
    .join('');
  const body = children.flat(Infinity as 1).filter((c): c is string => typeof c === 'string' && c !== '').join('');
  return body ? `<${name}${a}>${body}</${name}>` : `<${name}${a}/>`;
}

/** Текстовый элемент; пустые значения не выводятся. */
const txt = (name: string, value: string | number | null | undefined) =>
  value === null || value === undefined || value === '' ? null : `<${name}>${escText(clean(String(value)))}</${name}>`;

const fragment = (x: S['EvidenceFragment']) =>
  el(
    'fragment',
    {
      role: x.role,
      file_id: x.file_id,
      sha256: x.sha256,
      stage: x.stage,
      page: x.page,
      sheet: x.sheet,
      document_code: x.document_code,
      revision: x.revision,
      approval_status: x.approval_status,
      bbox: x.bbox.join(' '),
      polygon: x.polygon?.flat().join(' '),
      source: x.source,
      extraction_method: x.extraction_method,
      quality: x.quality,
      confidence: x.confidence,
    },
    txt('value', x.extracted_value),
    txt('normalized_value', x.normalized_value),
    txt('snippet', x.text_snippet),
  );

const decision = (d: S['FindingDecision']) =>
  el(
    'decision',
    { action: d.action, resulting_status: d.resulting_status, reason_code: d.reason_code, user_id: d.user_id, user_name: d.user_name, decided_at: d.decided_at },
    txt('comment', d.comment),
    txt('approved_change_ref', d.approved_change_ref),
  );

const finding = (f: S['Finding']) =>
  el(
    'finding',
    {
      id: f.id,
      finding_key: f.finding_key,
      param_code: f.param_code,
      rule_key: f.rule_key,
      section: f.section,
      finding_status: f.finding_status,
      completeness_status: f.completeness_status,
      inspector_status: f.inspector_status,
      review_priority: f.review_priority,
      confidence: f.confidence,
      evidence_changed: f.evidence_changed,
    },
    txt('param_name', f.param_name),
    txt('expected_value', f.expected_value),
    txt('actual_value', f.actual_value),
    txt('delta', f.delta),
    txt('unit', f.unit),
    txt('rationale', f.rationale),
    txt('normative_reference', f.normative_reference),
    txt('approved_change_ref', f.approved_change_ref),
    el(
      'evidence',
      { group_id: f.evidence_group.id, version: f.evidence_history?.at(-1)?.version, source: f.evidence_history?.at(-1)?.source },
      f.evidence_group.fragments.map(fragment),
    ),
    f.decision ? decision(f.decision) : null,
  );

export function renderXml(m: ExportModel): string {
  const p = m.protocol;
  const o = p.object;
  const c = m.completeness;
  const t = p.tables;
  const body = el(
    'protocol',
    {
      xmlns: 'urn:inspector-ai:protocol:1',
      id: p.id,
      process_id: p.process_id,
      version: p.version,
      status: p.status,
      trigger: p.trigger,
      created_at: p.created_at,
      finalized_at: p.finalized_at,
      exported_at: m.generatedAt,
    },
    el(
      'object',
      { id: o.id, external_id: o.external_id },
      txt('name', o.name),
      txt('address', o.address),
      txt('customer', o.customer),
      txt('contractor', o.contractor),
      txt('permit_number', o.permit_number),
    ),
    p.inspector ? el('inspector', { id: p.inspector.id, login: p.inspector.login }, txt('full_name', p.inspector.full_name)) : null,
    el('versions', { ...p.versions }),
    txt('scenario', p.scenario),
    el(
      'upload_status',
      {},
      p.upload_status.map((s) => el('stage', { code: s.slice(0, 2), status: s.slice(3) })),
    ),
    el(
      'completeness',
      {
        status: c.status,
        registry: c.registry,
        registry_file_name: c.registry_file_name,
        registry_uploaded_at: c.registry_uploaded_at,
        basis: c.basis,
        expected_total: c.expected_total,
        present_total: c.present_total,
      },
      txt('note', c.note),
      c.missing.map((e) => el('missing', { doc_stage: e.doc_stage, discipline: e.discipline, document_code: e.document_code, file_name: e.file_name }, txt('title', e.title))),
      c.issues.map((i) => el('issue', { code: i.code, file_id: i.file_id, external_file_id: i.external_file_id, file_name: i.file_name }, escText(clean(i.message)))),
    ),
    el(
      'input_files',
      {},
      p.input_files.map((f) =>
        el(
          'file',
          {
            id: f.id,
            external_file_id: f.external_file_id,
            sha256: f.sha256,
            format: f.format,
            stage: f.doc_stage,
            discipline: f.discipline,
            document_code: f.document_code,
            revision: f.revision,
            approval_status: f.approval_status,
            approval_date: f.approval_date,
            signature_status: f.signature_status,
            pages: f.quality?.pages_total,
            metadata_source: f.metadata_source,
            is_authoritative: f.is_authoritative,
          },
          txt('name', f.original_name),
          txt('authoritative_basis', f.authoritative_basis),
        ),
      ),
    ),
    el('summary', { ...p.summary }),
    el(
      'completeness_table',
      {},
      t.completeness.map((r) =>
        el(
          'row',
          {
            finding_id: r.finding_id,
            param_code: r.param_code,
            completeness_status: r.completeness_status,
            finding_status: r.finding_status,
            stages_present: (r.stages_present ?? []).join(' '),
          },
          txt('param_name', r.param_name),
          (r.missing_sources ?? []).map((x) => txt('missing_source', x)),
          txt('comment', r.comment),
        ),
      ),
    ),
    el('candidates', {}, t.candidates.map(finding)),
    el('confirmed_violations', {}, t.confirmed_violations.map(finding)),
    el('negative_verified', {}, t.negative_verified.map(finding)),
    el(
      'suspicions',
      {},
      t.suspicions.map((x) =>
        el(
          'suspicion',
          {
            id: x.suspicion_id,
            discovery_method: x.discovery_method,
            confidence: x.confidence,
            review_priority: x.review_priority,
            inspector_status: x.inspector_status,
            promoted_finding_id: x.promoted_finding_id,
          },
          txt('description', x.description),
          txt('pd_reference', x.pd_reference),
          txt('rd_reference', x.rd_reference),
          txt('id_reference', x.id_reference),
          el('evidence', {}, (x.evidence ?? []).map(fragment)),
        ),
      ),
    ),
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n${body}\n`;
}
