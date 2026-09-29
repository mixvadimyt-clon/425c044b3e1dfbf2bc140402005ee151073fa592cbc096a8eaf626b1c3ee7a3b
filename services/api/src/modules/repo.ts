import type { Db, Row } from '../db/sqlite.js';
import { parseJson, toBool, toBoolOrNull } from '../db/sqlite.js';
import { notFound } from '../errors.js';
import type { DocStage, ProcessStatus, S } from '../types.js';
import { type Completeness, type ExpectedDoc, type StageFile, computeCompleteness } from './stages.js';

/** Преобразование строк БД в объекты контракта (contracts/openapi/inspector-api.v1.yaml). */

const n = <T>(v: unknown): T | null => (v === undefined || v === null ? null : (v as T));

/**
 * Сведения о документе от ML (контракт 0.20.0): шифр проекта, язык, доля сканов, версия и
 * программы PDF, шифрование. ML кладёт их в словарь метаданных разбора, api хранит его целиком
 * (`files.metadata`), поэтому отдельной колонки не нужно. Размер файла — `size_bytes`, не дублируем.
 */
function documentFacts(metadata: unknown): Pick<
  S['FileInfo'],
  'project_code' | 'language' | 'scan_share' | 'pdf_version' | 'pdf_producer' | 'pdf_creator' | 'encrypted' | 'developer_org'
> {
  const m = parseJson<Record<string, unknown>>(metadata, {});
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  const language = ['ru', 'en', 'mixed'].includes(m.language as string) ? (m.language as S['FileInfo']['language']) : null;
  const share = typeof m.scan_share === 'number' && m.scan_share >= 0 && m.scan_share <= 1 ? m.scan_share : null;
  return {
    project_code: text(m.project_code),
    language,
    scan_share: share,
    pdf_version: text(m.pdf_version),
    pdf_producer: text(m.pdf_producer),
    pdf_creator: text(m.pdf_creator),
    encrypted: typeof m.encrypted === 'boolean' ? m.encrypted : null,
    developer_org: text(m.developer_org),
  };
}

/** Стадия файла: явный выбор пользователя/инспектора (stage_hint) важнее оценки по имени и ML (doc_stage). */
export function stageOfFile(r: Row): DocStage | null {
  return (r.stage_hint as DocStage) ?? (r.doc_stage as DocStage) ?? null;
}

export function mapFile(r: Row): S['FileInfo'] {
  return {
    id: r.id as string,
    object_id: r.object_id as string,
    process_id: r.process_id as string,
    original_name: r.original_name as string,
    format: r.format as S['FileFormat'],
    size_bytes: r.size_bytes as number,
    sha256: r.file_hash as string,
    doc_stage: stageOfFile(r),
    doc_kind: n(r.doc_kind),
    discipline: n(r.discipline),
    document_code: n(r.document_code),
    revision: n(r.revision),
    approval_status: (r.approval_status as S['ApprovalStatus']) ?? 'UNKNOWN',
    approval_date: n(r.approval_date),
    predecessor_id: n(r.predecessor_id),
    successor_id: null, // вычисляется в listFiles (нужен весь список)
    is_authoritative: toBoolOrNull(r.is_authoritative),
    metadata_confidence: n(r.metadata_confidence),
    metadata_source: (r.metadata_source as S['MetadataSource']) ?? 'FILENAME',
    authoritative_basis: n(r.authoritative_basis),
    external_file_id: n(r.external_file_id),
    signature: r.signature_sha256
      ? {
          file_name: r.signature_name as string,
          sha256: r.signature_sha256 as string,
          size_bytes: r.signature_size_bytes as number,
          uploaded_at: r.signature_uploaded_at as string,
          uploaded_by: n(r.signature_uploaded_by),
          // Подвязка: файл принят и хранится, криптографической проверки нет
          verification: 'NOT_VERIFIED',
        }
      : null,
    in_registry: toBool(r.in_registry),
    sheet_page_range: n(r.sheet_page_range),
    signature_status: (r.signature_status as S['SignatureStatus']) ?? 'UNKNOWN',
    duplicate_of: n(r.duplicate_of),
    ...exclusionOf(r, null, null),
    processing_status: r.processing_status as S['FileProcessingStatus'],
    quality: { pages_total: n<number>(r.pages_count) ?? undefined, ...parseJson<S['FileQuality']>(r.quality, {}) },
    error: n(r.error),
    title: n(r.title),
    ...documentFacts(r.metadata),
    storage_key: r.file_path as string,
    uploaded_by: n(r.uploaded_by),
    uploaded_by_name: n(r.uploaded_by_name),
    uploaded_at: r.uploaded_at as string,
  };
}

/**
 * Почему файл не идёт в эталонное сравнение («Перечень ИД» ред. 1.1): дубликат содержимого,
 * заменённая/аннулированная редакция, есть заменяющая редакция, инспектор исключил вручную.
 */
export function exclusionOf(
  r: Row,
  successorName: string | null,
  originalName: string | null,
): { excluded_from_comparison: boolean; exclusion_reason: string | null } {
  const reason = r.duplicate_of
    ? `Повторная загрузка того же содержимого${originalName ? ` (первый экземпляр: ${originalName})` : ''}`
    : r.is_authoritative === 1
      ? null // явный выбор инспектора важнее статуса редакции
      : r.approval_status === 'SUPERSEDED'
      ? 'Редакция заменена (SUPERSEDED), хранится для аудита'
      : r.approval_status === 'CANCELLED'
        ? 'Редакция аннулирована (CANCELLED)'
        : successorName
          ? `Заменена редакцией «${successorName}»`
          : r.is_authoritative === 0
            ? `Исключена инспектором${r.authoritative_basis ? `: ${String(r.authoritative_basis)}` : ''}`
            : null;
  return { excluded_from_comparison: reason !== null, exclusion_reason: reason };
}

export function listFiles(db: Db, processId: string): S['FileInfo'][] {
  const rows = db.all(
    `SELECT f.*, u.full_name AS uploaded_by_name FROM files f LEFT JOIN users u ON u.id = f.uploaded_by
     WHERE f.process_id = ? ORDER BY f.uploaded_at, f.original_name`,
    processId,
  );
  const byId = new Map(rows.map((r) => [r.id as string, r]));
  const successorOf = new Map(rows.filter((r) => r.predecessor_id && !r.duplicate_of).map((r) => [r.predecessor_id as string, r]));
  return rows.map((r) => {
    const succ = successorOf.get(r.id as string);
    const original = r.duplicate_of ? byId.get(r.duplicate_of as string) : undefined;
    return {
      ...mapFile(r),
      successor_id: (succ?.id as string) ?? null,
      ...exclusionOf(r, (succ?.original_name as string) ?? null, (original?.original_name as string) ?? null),
    };
  });
}

export function getFileRow(db: Db, fileId: string): Row {
  const r = db.get('SELECT * FROM files WHERE id = ?', fileId);
  if (!r) throw notFound('Файл');
  return r;
}

// ------------------------------------------------------------------ processes

/** Действующий реестр проверки (последний загруженный). */
export function activeRegistry(db: Db, processId: string): { row: Row; manifest: S['UploadManifest'] } | null {
  const row = db.get('SELECT * FROM registries WHERE process_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', processId);
  return row ? { row, manifest: parseJson<S['UploadManifest']>(row.entries, {}) } : null;
}

/** Полнота комплекта: файлы проверки против реестра и ожидаемого состава («Перечень ИД» ред. 1.1). */
export function completenessOf(db: Db, processId: string): Completeness {
  const files: StageFile[] = db.all('SELECT * FROM files WHERE process_id = ?', processId).map((f) => ({
    id: f.id as string,
    stage: stageOfFile(f),
    processing_status: f.processing_status as string,
    original_name: f.original_name as string,
    document_code: n<string>(f.document_code),
    discipline: n<string>(f.discipline),
    sha256: f.file_hash as string,
    in_registry: toBool(f.in_registry),
    registry_key: n<string>(f.registry_key),
    registry_sha256: n<string>(f.registry_sha256),
    external_file_id: n<string>(f.external_file_id),
    external_predecessor_id: n<string>(f.external_predecessor_id),
    duplicate_of: n<string>(f.duplicate_of),
    approval_status: n<string>(f.approval_status),
    predecessor_id: n<string>(f.predecessor_id),
    is_authoritative: toBoolOrNull(f.is_authoritative),
  }));
  const expected = db.all<ExpectedDoc>('SELECT doc_stage, discipline, document_code, file_name, title FROM expected_documents WHERE process_id = ?', processId);
  const reg = activeRegistry(db, processId);
  return computeCompleteness(files, expected, {
    present: Boolean(reg),
    file_name: reg ? n<string>(reg.row.original_name) : null,
    uploaded_at: reg ? (reg.row.created_at as string) : null,
    entries: reg?.manifest.files ?? [],
  });
}

/** Сводка полноты для ProcessInfo и ответа на загрузку реестра. */
export function completenessSummary(db: Db, processId: string): S['CompletenessSummary'] {
  const c = completenessOf(db, processId);
  return {
    status: c.status,
    registry: c.registry,
    registry_file_name: c.registry_file_name,
    registry_uploaded_at: c.registry_uploaded_at,
    basis: c.basis,
    expected_total: c.expected_total,
    present_total: c.present_total,
    missing: c.missing
      .filter((m) => m.doc_stage)
      .map((m) => ({
        doc_stage: m.doc_stage!,
        discipline: m.discipline ?? undefined,
        document_code: m.document_code ?? undefined,
        file_name: m.file_name ?? undefined,
        title: m.title ?? undefined,
      })),
    issues: c.issues,
    note: c.note,
  };
}

export function getProcessRow(db: Db, processId: string): Row {
  const r = db.get('SELECT * FROM processes WHERE id = ?', processId);
  if (!r) throw notFound('Проверка');
  return r;
}

export function countsForProtocol(db: Db, protocolId: string | null): S['FindingCounts'] {
  const empty: S['FindingCounts'] = {
    params_total: 0,
    candidates: 0,
    candidates_pending: 0,
    confirmed_violations: 0,
    negative_verified: 0,
    missing_evidence: 0,
    not_applicable: 0,
    not_comparable: 0,
    clarification_required: 0,
    suspicions: 0,
    compliance_percent: null,
  };
  if (!protocolId) return empty;
  const c = db.get<Record<string, number | null>>(
    `SELECT
       COUNT(DISTINCT param_code) AS params_total,
       SUM(CASE WHEN model_finding_status = 'CANDIDATE' THEN 1 ELSE 0 END) AS candidates,
       SUM(CASE WHEN finding_status = 'CANDIDATE' AND inspector_status = 'PENDING' THEN 1 ELSE 0 END) AS candidates_pending,
       SUM(CASE WHEN finding_status = 'CONFIRMED_VIOLATION' THEN 1 ELSE 0 END) AS confirmed_violations,
       SUM(CASE WHEN finding_status = 'NEGATIVE_VERIFIED' THEN 1 ELSE 0 END) AS negative_verified,
       SUM(CASE WHEN finding_status = 'MISSING_EVIDENCE' THEN 1 ELSE 0 END) AS missing_evidence,
       SUM(CASE WHEN finding_status = 'NOT_APPLICABLE' THEN 1 ELSE 0 END) AS not_applicable,
       SUM(CASE WHEN finding_status = 'NOT_COMPARABLE' THEN 1 ELSE 0 END) AS not_comparable,
       SUM(CASE WHEN finding_status = 'CLARIFICATION_REQUIRED' THEN 1 ELSE 0 END) AS clarification_required
     FROM checks WHERE protocol_id = ? AND is_split = 0`,
    protocolId,
  )!;
  const suspicions = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM suspicions WHERE protocol_id = ?', protocolId)!.n;
  const counts = Object.fromEntries(Object.entries(empty).map(([k]) => [k, Number(c[k] ?? 0)])) as S['FindingCounts'];
  counts.suspicions = suspicions;
  const comparable = counts.negative_verified! + counts.confirmed_violations! + (c.candidates_pending ?? 0);
  counts.compliance_percent = comparable > 0 ? Math.round((counts.negative_verified! / comparable) * 1000) / 10 : null;
  return counts;
}

export function indicatorFor(counts: S['FindingCounts'], status: ProcessStatus | null): S['ObjectIndicator'] {
  if ((counts.confirmed_violations ?? 0) > 0) return 'RED';
  if (
    (counts.candidates_pending ?? 0) > 0 ||
    (counts.clarification_required ?? 0) > 0 ||
    (counts.missing_evidence ?? 0) > 0 ||
    status === 'PARSING' ||
    status === 'FAILED'
  ) {
    return 'YELLOW';
  }
  return 'GREEN';
}

export const UPLOADABLE: ProcessStatus[] = ['PENDING', 'READY', 'VERIFYING', 'COMPLETED', 'FAILED'];
export const DECIDABLE: ProcessStatus[] = ['READY', 'VERIFYING', 'COMPLETED'];

export function mapProcessStatus(r: Row): S['ProcessStatusInfo'] {
  return {
    process_id: r.id as string,
    status: r.status as ProcessStatus,
    progress: parseJson<S['ProcessProgress']>(r.progress, {}),
    current_protocol_id: n(r.current_protocol_id),
    current_protocol_version: null,
    sync_status: (r.sync_status as S['SyncStatus']) ?? 'NOT_SENT',
    error: n(r.error),
    updated_at: r.updated_at as string,
  };
}

export function getProcessStatus(db: Db, processId: string): S['ProcessStatusInfo'] {
  const r = getProcessRow(db, processId);
  const info = mapProcessStatus(r);
  if (r.current_protocol_id) {
    info.current_protocol_version =
      db.get<{ version: number }>('SELECT version FROM protocols WHERE id = ?', r.current_protocol_id as string)?.version ?? null;
  }
  return info;
}

export function getProcessInfo(db: Db, processId: string): S['ProcessInfo'] {
  const r = getProcessRow(db, processId);
  const status = r.status as ProcessStatus;
  const counts = countsForProtocol(db, n(r.current_protocol_id));
  return {
    ...getProcessStatus(db, processId),
    object_id: r.object_id as string,
    scenario: n(r.scenario),
    upload_status: parseJson<S['StageUploadStatus'][]>(r.upload_status, []),
    can_upload: UPLOADABLE.includes(status),
    can_verify: status === 'READY' || status === 'VERIFYING',
    can_finalize: DECIDABLE.includes(status) && (counts.candidates_pending ?? 0) === 0,
    counts,
    completeness: completenessSummary(db, processId),
    created_by: (r.created_by as string) ?? undefined,
    created_at: r.created_at as string,
    finalized_at: n(r.finalized_at),
    finalized_by: n(r.finalized_by),
  };
}

// -------------------------------------------------------------------- objects

export function mapObject(db: Db, r: Row): S['ObjectInfo'] {
  const last = db.get('SELECT * FROM processes WHERE object_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', r.id as string);
  const counts = countsForProtocol(db, last ? n(last.current_protocol_id) : null);
  const lastStatus = last ? (last.status as ProcessStatus) : null;
  return {
    id: r.id as string,
    name: r.name as string,
    address: (r.address as string) ?? undefined,
    customer: (r.customer as string) ?? undefined,
    contractor: (r.contractor as string) ?? undefined,
    permit_number: (r.permit_number as string) ?? undefined,
    external_id: n(r.external_id),
    indicator: indicatorFor(counts, lastStatus),
    last_process_id: last ? (last.id as string) : null,
    last_process_status: lastStatus,
    counts,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

export function getObject(db: Db, objectId: string): S['ObjectInfo'] {
  const r = db.get('SELECT * FROM objects WHERE id = ?', objectId);
  if (!r) throw notFound('Объект');
  return mapObject(db, r);
}

// ------------------------------------------------------------------- findings

export function mapFragment(r: Row): S['EvidenceFragment'] {
  return {
    id: r.id as string,
    role: r.role as S['EvidenceRole'],
    file_id: r.file_id as string,
    sha256: r.sha256 as string,
    stage: r.stage as DocStage,
    document_code: n(r.document_code),
    revision: n(r.revision),
    approval_status: (r.approval_status as S['ApprovalStatus']) ?? 'UNKNOWN',
    page: r.page as number,
    sheet: n(r.sheet),
    bbox: parseJson<number[]>(r.bbox, [0, 0, 1, 1]),
    polygon: parseJson<number[][] | null>(r.polygon, null),
    extracted_value: n(r.extracted_value),
    normalized_value: n(r.normalized_value),
    text_snippet: n(r.text_snippet),
    source: (r.source as S['TextSource']) ?? 'TEXT_LAYER',
    extraction_method: n<S['ExtractionMethod']>(r.extraction_method),
    quality: (r.quality as S['PageQuality']) ?? 'OK',
    confidence: (r.confidence as number) ?? 1,
  };
}

export function fragmentsOfGroup(db: Db, groupId: string): S['EvidenceFragment'][] {
  return db
    .all("SELECT * FROM evidence_fragments WHERE evidence_group_id = ? ORDER BY CASE role WHEN 'EXPECTED' THEN 0 WHEN 'ACTUAL' THEN 1 ELSE 2 END, stage, page", groupId)
    .map(mapFragment);
}

function mapDecision(r: Row): S['FindingDecision'] {
  return {
    action: r.action as S['InspectorAction'],
    resulting_status: r.resulting_status as S['InspectorStatus'],
    reason_code: n(r.reason_code),
    comment: n(r.comment),
    approved_change_ref: n(r.approved_change_ref),
    user_id: r.user_id as string,
    user_name: (r.user_name as string) ?? '',
    decided_at: r.decided_at as string,
  };
}

export function mapFinding(db: Db, r: Row): S['Finding'] {
  const param = db.get<{ parameter_name: string; section: string; trigger_logic: string | null }>(
    'SELECT parameter_name, section, trigger_logic FROM params WHERE code = ?',
    r.param_code as string,
  );
  const history = db
    .all(
      `SELECT d.*, u.full_name AS user_name FROM finding_decisions d LEFT JOIN users u ON u.id = d.user_id
       WHERE d.check_id = ? ORDER BY d.decided_at, d.rowid`,
      r.id as string,
    )
    .map(mapDecision);
  const priority = r.review_priority as S['ReviewPriority'];
  return {
    id: r.id as string,
    finding_key: r.finding_key as string,
    protocol_id: r.protocol_id as string,
    object_id: r.object_id as string,
    param_id: n(r.param_id),
    param_code: r.param_code as string,
    param_name: param?.parameter_name ?? (r.param_code as string),
    section: param?.section ?? '',
    rule_key: n(r.rule_key),
    finding_status: r.finding_status as S['FindingStatus'],
    completeness_status: r.completeness_status as S['CompletenessStatus'],
    stages_compared: parseJson<DocStage[]>(r.stages_compared, []),
    expected_value: n(r.expected_value),
    actual_value: n(r.actual_value),
    delta: n(r.delta),
    stage_comparisons: parseJson<S['StageComparison'][]>(r.stage_comparisons, []),
    unit: n(r.unit),
    review_priority: priority,
    risk_level: (r.risk_level as S['ReviewPriority']) ?? priority,
    rationale: n(r.rationale),
    trigger_logic: param?.trigger_logic ?? null,
    rationale_source: (r.rationale_source as S['RationaleSource']) ?? 'RULES',
    normative_reference: n(r.normative_reference),
    confidence: n(r.confidence),
    approved_change_ref: n(r.approved_change_ref),
    evidence_group: { id: r.evidence_group_id as string, fragments: fragmentsOfGroup(db, r.evidence_group_id as string) },
    evidence_history: evidenceHistory(db, r.evidence_group_id as string),
    inspector_status: r.inspector_status as S['InspectorStatus'],
    decision: history.length ? history[history.length - 1] : null,
    decision_history: history,
    parent_finding_id: n(r.parent_check_id),
    is_split: toBool(r.is_split),
    evidence_changed: toBool(r.evidence_changed),
    page_pair_id: n(r.page_pair_id),
  };
}

/** Цепочка версий доказательств: от исходной (MODEL) к текущей. */
export function evidenceHistory(db: Db, groupId: string): S['EvidenceVersion'][] {
  const chain: S['EvidenceVersion'][] = [];
  let id: string | null = groupId;
  const guard = new Set<string>();
  while (id && !guard.has(id)) {
    guard.add(id);
    const g: Row | undefined = db.get(
      `SELECT g.*, u.full_name AS user_name, (SELECT COUNT(*) FROM evidence_fragments f WHERE f.evidence_group_id = g.id) AS cnt
       FROM evidence_groups g LEFT JOIN users u ON u.id = g.created_by WHERE g.id = ?`,
      id,
    );
    if (!g) break;
    chain.unshift({
      group_id: g.id as string,
      version: (g.version as number) ?? 1,
      source: (g.source as S['EvidenceSource']) ?? 'MODEL',
      created_by: n(g.created_by),
      created_by_name: n(g.user_name),
      created_at: g.created_at as string,
      reason: n(g.reason),
      reference: n(g.reference),
      fragments_count: g.cnt as number,
    });
    id = n<string>(g.previous_group_id);
  }
  return chain;
}

/** Последняя машинная (MODEL) версия в цепочке — для сравнения с новым результатом модели. */
export function modelGroupOf(db: Db, groupId: string): string {
  let id: string | null = groupId;
  const guard = new Set<string>();
  while (id && !guard.has(id)) {
    guard.add(id);
    const g: Row | undefined = db.get('SELECT id, source, previous_group_id FROM evidence_groups WHERE id = ?', id);
    if (!g) break;
    if ((g.source ?? 'MODEL') === 'MODEL') return g.id as string;
    id = n<string>(g.previous_group_id);
  }
  return groupId;
}

export function getCheckRow(db: Db, checkId: string): Row {
  const r = db.get('SELECT * FROM checks WHERE id = ?', checkId);
  if (!r) throw notFound('Finding');
  return r;
}

export function mapSuspicion(r: Row): S['Suspicion'] {
  return {
    suspicion_id: r.id as string,
    suspicion_key: r.suspicion_key as string,
    object_id: r.object_id as string,
    protocol_id: r.protocol_id as string,
    discovery_method: r.discovery_method as S['DiscoveryMethod'],
    confidence: r.confidence as number,
    description: r.description as string,
    pd_reference: n(r.pd_reference),
    rd_reference: n(r.rd_reference),
    id_reference: n(r.id_reference),
    review_priority: r.review_priority as S['ReviewPriority'],
    normative_base: n(r.normative_base),
    finding_status: 'SUSPICION',
    inspector_status: r.inspector_status as S['Suspicion']['inspector_status'],
    rule_id: n(r.rule_id),
    evidence: parseJson<S['EvidenceFragment'][]>(r.evidence, []),
    promoted_finding_id: n(r.promoted_check_id),
    page_pair_id: n(r.page_pair_id),
  };
}

// ------------------------------------------------------------------ page pairs

function pageRef(db: Db, fileId: string, page: number): S['PageRef'] {
  const f = db.get('SELECT * FROM files WHERE id = ?', fileId);
  const sheets = parseJson<{ sheets?: { page: number; sheet?: string | null }[] }>(f?.metadata, {}).sheets ?? [];
  return {
    file_id: fileId,
    page,
    stage: (f && stageOfFile(f)) ?? 'PD',
    document_code: f ? n(f.document_code) : null,
    revision: f ? n(f.revision) : null,
    sheet: sheets.find((s) => s.page === page)?.sheet ?? null,
    original_name: (f?.original_name as string) ?? '',
  };
}

export function mapPagePair(db: Db, r: Row): S['PagePair'] {
  return {
    id: r.id as string,
    left: pageRef(db, r.left_file_id as string, r.left_page as number),
    right: pageRef(db, r.right_file_id as string, r.right_page as number),
    match_score: r.match_score as number,
    homography: parseJson<number[] | null>(r.homography, null),
    compliance_percent: n(r.compliance_percent),
    diff_regions: parseJson<S['DiffRegion'][]>(r.diff_regions, []),
    finding_ids: db
      .all<{ id: string }>('SELECT id FROM checks WHERE page_pair_id = ? AND is_split = 0', r.id as string)
      .map((x) => x.id),
  };
}

// ------------------------------------------------------------------ protocols

export function getProtocolRow(db: Db, protocolId: string): Row {
  const r = db.get('SELECT * FROM protocols WHERE id = ?', protocolId);
  if (!r) throw notFound('Протокол');
  return r;
}

export function mapProtocolVersion(r: Row): S['ProtocolVersionInfo'] {
  return {
    id: r.id as string,
    process_id: r.process_id as string,
    version: r.version as number,
    status: r.status as S['ProtocolVerificationStatus'],
    is_current: toBool(r.is_current),
    trigger: r.trigger as S['ProtocolVersionInfo']['trigger'],
    versions: {
      matrix_version: r.matrix_version as string,
      model_version: r.model_version as string,
      dataset_version: r.dataset_version as string,
      parser_version: (r.parser_version as string) ?? undefined,
      input_manifest_hash: r.input_manifest_hash as string,
    },
    created_at: r.created_at as string,
    finalized_at: n(r.finalized_at),
  };
}

export function getProtocol(db: Db, protocolId: string): S['Protocol'] {
  const r = getProtocolRow(db, protocolId);
  const proc = getProcessRow(db, r.process_id as string);
  const snapshot = parseJson<{ input_files?: S['FileInfo'][] }>(r.snapshot, {});
  const checks = db
    .all('SELECT * FROM checks WHERE protocol_id = ? AND is_split = 0 ORDER BY review_priority, param_code, rule_key', protocolId)
    .map((c) => mapFinding(db, c));
  const params = new Map(
    db.all<{ code: string; source_pd: string; source_rd: string; source_id: string }>('SELECT code, source_pd, source_rd, source_id FROM params').map((p) => [p.code, p]),
  );
  const completeness: S['CompletenessRow'][] = checks.map((f) => {
    const row = db.get<{ missing_sources: string }>('SELECT missing_sources FROM checks WHERE id = ?', f.id)!;
    return {
      finding_id: f.id,
      param_code: f.param_code,
      param_name: f.param_name,
      section: f.section,
      completeness_status: f.completeness_status,
      finding_status: f.finding_status,
      stages_present: [...new Set(f.evidence_group.fragments.map((x) => x.stage))],
      missing_sources: parseJson<string[]>(row.missing_sources, []),
      comment: params.has(f.param_code) ? null : 'Параметр отсутствует в текущей матрице',
    };
  });
  const decider = db.get<Row>(
    `SELECT u.* FROM finding_decisions d JOIN checks c ON c.id = d.check_id JOIN users u ON u.id = d.user_id
     WHERE c.protocol_id = ? ORDER BY d.decided_at DESC LIMIT 1`,
    protocolId,
  );
  return {
    ...mapProtocolVersion(r),
    object: getObject(db, r.object_id as string),
    scenario: (r.scenario as S['CheckScenario']) ?? 'SINGLE_ONLY',
    upload_status: parseJson<S['StageUploadStatus'][]>(r.upload_status, []),
    input_files: snapshot.input_files ?? [],
    summary: countsForProtocol(db, protocolId),
    inspector: decider
      ? { id: decider.id as string, login: decider.login as string, full_name: decider.full_name as string, role: decider.role as S['UserRole'] }
      : null,
    sync_status: (proc.sync_status as S['SyncStatus']) ?? 'NOT_SENT',
    tables: {
      completeness,
      candidates: checks.filter((f) => db.get<{ m: string }>('SELECT model_finding_status AS m FROM checks WHERE id = ?', f.id)!.m === 'CANDIDATE'),
      confirmed_violations: checks.filter((f) => f.finding_status === 'CONFIRMED_VIOLATION'),
      negative_verified: checks.filter((f) => f.finding_status === 'NEGATIVE_VERIFIED'),
      suspicions: db.all('SELECT * FROM suspicions WHERE protocol_id = ? ORDER BY review_priority, confidence DESC', protocolId).map(mapSuspicion),
    },
  };
}

export function userName(db: Db, userId: string | null | undefined): string {
  if (!userId) return '';
  return db.get<{ full_name: string }>('SELECT full_name FROM users WHERE id = ?', userId)?.full_name ?? '';
}
