import { useQuery } from '@tanstack/react-query';
import { API_URL, apiClient } from './client';
import type { components } from './schema';
import type { ApiFinding } from './findings';
import { toStageComparisons } from '@/shared/stageComparisons';
import { withoutLongDash } from '@/shared/text';
import type {
  ApprovalKey,
  ProtocolFinding,
  ProtocolVersion,
  RegistryFile,
  RejectReasonKey,
  StageLabel,
  Suspicion,
  EvidenceSource,
} from '@/pages/protocol/protocolData';

export type ApiProtocol = components['schemas']['Protocol'];
export type ProtocolVersionInfo = components['schemas']['ProtocolVersionInfo'];
export type SyncInfo = components['schemas']['SyncInfo'];
type ApiSuspicion = components['schemas']['Suspicion'];
type FileInfo = components['schemas']['FileInfo'];
type DocStage = components['schemas']['DocStage'];
type CompletenessStatus = components['schemas']['CompletenessStatus'];
export type ExportFormat = components['schemas']['ExportFormat'];


const STAGE_LABEL: Record<DocStage, StageLabel> = { PD: 'ПД', RD: 'РД', ID: 'ИД' };

const pad = (n: number) => String(n).padStart(2, '0');

export const formatDateTime = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** «Загрузил Иванов Иван, 24.09.2026 11:45»: кто и когда загрузил файл; пусто, если ни имени, ни даты нет. */
export const uploadedLine = (name: string | null | undefined, iso: string | null | undefined): string => {
  const when = formatDateTime(iso);
  if (name && when) return `Загрузил ${name}, ${when}`;
  if (name) return `Загрузил ${name}`;
  return when ? `Загружен ${when}` : '';
};

// ---- Запросы ----

export const useProtocolVersions = (processId: string | null | undefined, refreshKey?: string) =>
  useQuery({
    queryKey: ['protocol-versions', processId, refreshKey],
    enabled: Boolean(processId),
    staleTime: 0,
    queryFn: async () => {
      const { data, error } = await apiClient.GET('/api/v1/processes/{process_id}/protocols', { params: { path: { process_id: processId! } } });
      if (error || !data) throw new Error('Не удалось загрузить версии протокола');
      return data;
    },
  });

export const useProtocol = (protocolId: string | null | undefined, refreshKey?: string) =>
  useQuery({
    queryKey: ['protocol', protocolId, refreshKey],
    enabled: Boolean(protocolId),
    staleTime: 0,
    queryFn: async () => {
      const { data, error } = await apiClient.GET('/api/v1/protocols/{protocol_id}', { params: { path: { protocol_id: protocolId! } } });
      if (error || !data) throw new Error('Не удалось загрузить протокол');
      return data;
    },
  });

export const useSyncInfo = (processId: string | null | undefined, enabled: boolean) =>
  useQuery({
    queryKey: ['inspection-sync', processId],
    enabled: Boolean(processId) && enabled,
    staleTime: 0,
    queryFn: async () => {
      const { data, error } = await apiClient.GET('/api/v1/inspection/{process_id}/sync', { params: { path: { process_id: processId! } } });
      if (error || !data) throw new Error('Не удалось получить статус передачи');
      return data;
    },
    // Пока идёт передача, обновляем статус
    refetchInterval: (query) => (query.state.data?.sync_status === 'PENDING_SYNC' ? 5000 : false),
  });

// ---- Действия ----

export const finalizeProcess = async (processId: string): Promise<void> => {
  const { error } = await apiClient.POST('/api/v1/processes/{process_id}/finalize', { params: { path: { process_id: processId } } });
  if (error) throw new Error(error.message ?? 'Не удалось завершить проверку');
};

export const unfinalizeProcess = async (processId: string, reason: string): Promise<void> => {
  const { error } = await apiClient.POST('/api/v1/processes/{process_id}/unfinalize', { params: { path: { process_id: processId } }, body: { reason } });
  if (error) throw new Error(error.message ?? 'Не удалось отменить финализацию');
};

export const retrySync = async (processId: string): Promise<void> => {
  const { error } = await apiClient.POST('/api/v1/inspection/{process_id}', { params: { path: { process_id: processId } } });
  if (error) throw new Error(error.message ?? 'Не удалось поставить отправку в очередь');
};

/** Имя файла из заголовка content-disposition (в том числе filename*=UTF-8''…). */
export const fileNameFromDisposition = (header: string | null): string | null => {
  if (!header) return null;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1]);
    } catch {
      /* берём обычное имя */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1] : null;
};

/** GET /protocols/{id}/export: скачивание файла (браузер не подставит Bearer сам, поэтому через fetch). */
export const downloadProtocol = async (protocolId: string, format: ExportFormat, fallbackName: string): Promise<void> => {
  const token = localStorage.getItem('auth_token');
  const response = await fetch(`${API_URL}/api/v1/protocols/${protocolId}/export?format=${format}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `Не удалось выгрузить протокол (${response.status})`);
  }
  const blob = await response.blob();
  const name = fileNameFromDisposition(response.headers.get('content-disposition')) ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
};

// ---- Приведение к виду, который рисует страница протокола ----

const toSources = (finding: ApiFinding, filesById: Map<string, FileInfo>): EvidenceSource[] =>
  finding.evidence_group.fragments.map((fragment) => {
    const [x0, y0, x1, y1] = fragment.bbox;
    return {
      role: fragment.role === 'EXPECTED' ? 'EXPECTED' : 'ACTUAL',
      stage: STAGE_LABEL[fragment.stage],
      value: fragment.extracted_value ?? fragment.normalized_value ?? '',
      fileId: fragment.file_id,
      fileName: filesById.get(fragment.file_id)?.original_name ?? fragment.document_code ?? '',
      sha256: fragment.sha256,
      cipher: fragment.document_code ?? '',
      revision: fragment.revision ?? '',
      approval: (fragment.approval_status ?? 'UNKNOWN') as ApprovalKey,
      sheet: fragment.sheet ? `Лист ${fragment.sheet}` : '',
      page: fragment.page,
      bbox: [x0, y0, x1 - x0, y1 - y0],
    };
  });

const evidenceVersionLabel = (finding: ApiFinding): string => {
  const last = finding.evidence_history?.[finding.evidence_history.length - 1];
  if (!last) return 'v1 (машинная)';
  return `v${last.version} (${last.source === 'MODEL' ? 'машинная' : 'инспектора'})`;
};

export const toProtocolFinding = (finding: ApiFinding, files: FileInfo[], rows: ApiProtocol['tables']['completeness']): ProtocolFinding => {
  const filesById = new Map(files.map((f) => [f.id, f]));
  const row = rows.find((r) => r.finding_id === finding.id);
  const decision = finding.decision;
  return {
    id: finding.id,
    paramCode: finding.param_code,
    ruleKey: finding.rule_key ?? '',
    paramName: finding.param_name ?? finding.param_code,
    section: finding.section,
    status: finding.finding_status,
    priority: finding.review_priority,
    expected: finding.expected_value ?? undefined,
    actual: finding.actual_value ?? undefined,
    delta: finding.delta ?? undefined,
    stageComparisons: toStageComparisons(finding.stage_comparisons),
    triggerLogic: finding.trigger_logic ? withoutLongDash(finding.trigger_logic) : undefined,
    rationale: withoutLongDash(finding.rationale ?? ''),
    rationaleSource: finding.rationale_source === 'LLM' ? 'AI' : 'RULES',
    normative: finding.normative_reference ?? undefined,
    sources: toSources(finding, filesById),
    decision: decision
      ? {
          action: decision.action,
          reasonCode: (decision.reason_code ?? undefined) as RejectReasonKey | undefined,
          comment: decision.comment ?? '',
          by: decision.user_name ?? '',
          at: formatDateTime(decision.decided_at),
        }
      : undefined,
    approvedChangeRef: finding.approved_change_ref ?? undefined,
    evidenceVersion: evidenceVersionLabel(finding),
    request: row?.missing_sources?.length ? `Загрузить: ${row.missing_sources.join(', ')}` : (row?.comment ?? undefined),
  };
};

const toSuspicion = (s: ApiSuspicion): Suspicion => {
  const evidence = s.evidence?.[0];
  const stage: StageLabel = evidence ? STAGE_LABEL[evidence.stage] : s.pd_reference ? 'ПД' : s.rd_reference ? 'РД' : s.id_reference ? 'ИД' : 'ПД';
  return {
    id: s.suspicion_id,
    code: s.rule_id ?? s.suspicion_key ?? 'FREE',
    topic: s.discovery_method,
    description: s.description,
    confidence: s.confidence,
    stage,
    fileName: s.pd_reference ?? s.rd_reference ?? s.id_reference ?? '',
    page: evidence?.page ?? 0,
  };
};

/** «Страниц прочитано»: с текстовым слоем и распознанные из всех, как «20 / 20» в демо-данных; без сведений о разборе «нет». */
export const pagesRead = (quality: FileInfo['quality']): string => {
  if (!quality || quality.pages_total === undefined) return 'нет';
  return `${(quality.pages_text_layer ?? 0) + (quality.pages_ocr ?? 0)} / ${quality.pages_total}`;
};

const toRegistryFile = (f: FileInfo): RegistryFile => ({
  fileId: f.external_file_id ?? f.id,
  fileName: f.original_name,
  stage: f.doc_stage ? STAGE_LABEL[f.doc_stage] : 'ПД',
  cipher: f.document_code ?? 'нет',
  revision: f.revision ?? 'нет',
  approval: (f.approval_status ?? 'UNKNOWN') as ApprovalKey,
  sha256: f.sha256,
  pages: pagesRead(f.quality),
  title: f.title ?? undefined,
  uploaded: uploadedLine(f.uploaded_by_name, f.uploaded_at) || undefined,
});

const stageStatus = (uploadStatus: string[], code: DocStage): string => uploadStatus.find((s) => s.startsWith(`${code}_`)) ?? `${code}_MISSING`;

interface BuildInput {
  protocol: ApiProtocol;
  findings: ApiFinding[];
  completeness: CompletenessStatus | undefined;
}

/** Собирает из ответов api версию протокола в том виде, который рисует страница (те же поля, что у демо-версий). */
export const toProtocolVersion = ({ protocol, findings, completeness }: BuildInput): ProtocolVersion => {
  const created = formatDateTime(protocol.created_at);
  return {
    value: protocol.id,
    number: String(protocol.version),
    label: `Версия ${protocol.version} (${created}${protocol.is_current ? ', текущая' : ''})`,
    createdAt: created,
    current: Boolean(protocol.is_current),
    matrixVersion: protocol.versions.matrix_version,
    modelVersion: protocol.versions.model_version,
    datasetVersion: protocol.versions.dataset_version,
    manifestHash: protocol.versions.input_manifest_hash,
    scenario: protocol.scenario,
    uploadStatus: {
      pd: stageStatus(protocol.upload_status, 'PD'),
      rd: stageStatus(protocol.upload_status, 'RD'),
      id: stageStatus(protocol.upload_status, 'ID'),
    },
    completeness: completeness ?? 'CLARIFICATION_REQUIRED',
    registry: protocol.input_files.map(toRegistryFile),
    // Расщеплённые составные кандидаты сами не верифицируются — в протоколе остаются их части
    findings: findings.filter((f) => !f.is_split).map((f) => toProtocolFinding(f, protocol.input_files, protocol.tables.completeness)),
    suspicions: protocol.tables.suspicions.map(toSuspicion),
  };
};
