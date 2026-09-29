import { useQuery } from '@tanstack/react-query';
import { apiClient } from './client';
import { stageLabel } from './pagePairs';
import type { components } from './schema';

export type ApiSuspicion = components['schemas']['Suspicion'];
export type Fragment = components['schemas']['EvidenceFragment'];
export type PromoteRequest = components['schemas']['PromoteSuspicionRequest'];
export type MatrixParam = components['schemas']['MatrixParam'];

/** `GET /processes/{id}/suspicions`: гипотезы свободного поиска (не нарушения, пока инспектор не сделал их кандидатами). */
export const useSuspicions = (processId: string | null | undefined, enabled = true) =>
  useQuery({
    queryKey: ['suspicions', processId],
    enabled: Boolean(processId) && enabled,
    staleTime: 0,
    queryFn: async () => {
      const { data, error } = await apiClient.GET('/api/v1/processes/{process_id}/suspicions', { params: { path: { process_id: processId! } } });
      if (error || !data) throw new Error('Не удалось загрузить гипотезы');
      return data;
    },
  });

/** Параметры матрицы для выбора при переводе гипотезы в кандидата. */
export const useMatrixParams = (enabled = true) =>
  useQuery({
    queryKey: ['matrix-params'],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await apiClient.GET('/api/v1/admin/params', { params: { query: { is_active: true } } });
      if (error || !data) throw new Error('Не удалось загрузить параметры матрицы');
      return data;
    },
  });

/** `POST /suspicions/{id}/decision`: отклонить (`DISMISS`) или отправить на уточнение (`CLARIFY`), комментарий обязателен. */
export const decideSuspicion = async (suspicionId: string, action: 'DISMISS' | 'CLARIFY', comment: string): Promise<ApiSuspicion> => {
  const { data, error } = await apiClient.POST('/api/v1/suspicions/{suspicion_id}/decision', {
    params: { path: { suspicion_id: suspicionId } },
    body: { action, comment: comment.trim() },
  });
  if (error || !data) throw new Error((error as { message?: string } | undefined)?.message ?? 'Не удалось сохранить решение по гипотезе');
  return data;
};

/** `POST /suspicions/{id}/promote`: гипотеза становится кандидатом с доказательствами и параметром матрицы. */
export const promoteSuspicion = async (suspicionId: string, body: PromoteRequest) => {
  const { data, error } = await apiClient.POST('/api/v1/suspicions/{suspicion_id}/promote', { params: { path: { suspicion_id: suspicionId } }, body });
  if (error || !data) throw new Error(error?.message ?? 'Не удалось сделать гипотезу кандидатом');
  return data;
};

export const METHOD_LABEL: Record<ApiSuspicion['discovery_method'], string> = {
  LOGICAL_ANALYSIS: 'Логика',
  SEMANTIC_DISSONANCE: 'Смысл',
  NORMATIVE_ANALYSIS: 'Нормы',
  ML_PATTERN: 'Шаблон ML',
  VISUAL_DIFF: 'Визуальное различие',
};

export const SUSPICION_STATUS: Record<ApiSuspicion['inspector_status'], { label: string; tone: 'wait' | 'done' | 'clarify' | 'promoted' }> = {
  PENDING: { label: 'Ожидает решения', tone: 'wait' },
  DISMISSED: { label: 'Отклонена', tone: 'done' },
  CLARIFICATION_REQUIRED: { label: 'Требует уточнения', tone: 'clarify' },
  PROMOTED: { label: 'Стала кандидатом', tone: 'promoted' },
};

/** Плашка статуса в списке: те же классы, что у статусов несоответствий. */
export const SUSPICION_BADGE: Record<ApiSuspicion['inspector_status'], { cls: string; label: string }> = {
  PENDING: { cls: 'badge-amber', label: 'ОЖИДАЕТ' },
  CLARIFICATION_REQUIRED: { cls: 'badge-slate', label: 'УТОЧНЕНО' },
  DISMISSED: { cls: 'badge-red', label: 'ОТКЛОНЕНО' },
  PROMOTED: { cls: 'badge-green', label: 'КАНДИДАТ' },
};

/** Ссылки на документы гипотезы одной строкой: «ПД KR-AR, стр. 1 · РД KZh01, стр. 1». */
export const suspicionRefs = (s: ApiSuspicion): string =>
  [s.pd_reference && `ПД ${s.pd_reference}`, s.rd_reference && `РД ${s.rd_reference}`, s.id_reference && `ИД ${s.id_reference}`].filter(Boolean).join(', ');

const STAGE_ORDER: Record<string, number> = { PD: 0, RD: 1, ID: 2 };

/**
 * Роль фрагмента гипотезы при переводе в кандидата (в гипотезе они «контекст»): у самой ранней стадии — эталон, у остальных — фактическое;
 * если стадия одна, эталоном считается ПД. Инспектор может поменять роль в форме.
 */
export const defaultRole = (stage: string, stages: string[]): 'EXPECTED' | 'ACTUAL' => {
  const first = [...stages].sort((a, b) => (STAGE_ORDER[a] ?? 9) - (STAGE_ORDER[b] ?? 9))[0];
  return stage === first && (stages.length > 1 || stage === 'PD') ? 'EXPECTED' : 'ACTUAL';
};

export const evidenceStages = (evidence: Fragment[] | undefined): string[] => [...new Set((evidence ?? []).map((f) => f.stage))];

export const fragmentLabel = (f: Pick<Fragment, 'stage' | 'page' | 'extracted_value'>): string => `${stageLabel(f.stage)}, стр. ${f.page}${f.extracted_value ? `, ${f.extracted_value}` : ''}`;

const STAGE_CODE_OF = { 'ПД': 'PD', 'РД': 'RD', 'ИД': 'ID' } as const;

export interface PromoteInput {
  paramCode: string;
  expected: string;
  actual: string;
  comment: string;
  /** Фрагменты гипотезы, их роли и убранные из списка индексы. */
  evidence: Fragment[];
  roles: Record<number, Fragment['role']>;
  removed: number[];
  /** Рамки, нарисованные инспектором (проценты страницы). */
  drafts: Array<{ stage: 'ПД' | 'РД' | 'ИД'; fileId: string; page: number; bbox: { x: number; y: number; w: number; h: number }; role: 'EXPECTED' | 'ACTUAL'; value: string }>;
  files: Array<{ id: string; sha256: string; document_code?: string | null; revision?: string | null; approval_status?: Fragment['approval_status'] }>;
}

/**
 * Тело `POST /suspicions/{id}/promote`. Фрагменты гипотезы уходят как новые: без чужого id и без пустого polygon
 * (сервер принимает его только с тремя точками и более); пустое значение фрагмента берётся из «Ожидается» / «Фактически» по роли.
 */
export const buildPromoteBody = ({ paramCode, expected, actual, comment, evidence, roles, removed, drafts, files }: PromoteInput): PromoteRequest => {
  const valueOf = (role: string, own?: string | null) => own?.trim() || (role === 'EXPECTED' ? expected.trim() : role === 'ACTUAL' ? actual.trim() : '');
  const fromEvidence = evidence.flatMap((f, i) => {
    if (removed.includes(i)) return [];
    const { id: _id, polygon, ...rest } = f;
    void _id;
    const role = roles[i] ?? f.role;
    const value = valueOf(role, f.extracted_value);
    return [{ ...rest, role, ...(value ? { extracted_value: value, normalized_value: rest.normalized_value || value } : {}), ...(Array.isArray(polygon) && polygon.length >= 3 ? { polygon } : {}) }];
  });
  const fromDrawn = drafts.map((d) => {
    const file = files.find((x) => x.id === d.fileId);
    const value = valueOf(d.role, d.value);
    return {
      role: d.role,
      file_id: d.fileId,
      sha256: file?.sha256 ?? '',
      stage: STAGE_CODE_OF[d.stage],
      document_code: file?.document_code ?? undefined,
      revision: file?.revision ?? undefined,
      approval_status: file?.approval_status,
      page: d.page,
      bbox: [d.bbox.x / 100, d.bbox.y / 100, (d.bbox.x + d.bbox.w) / 100, (d.bbox.y + d.bbox.h) / 100],
      ...(value ? { extracted_value: value } : {}),
      source: 'MANUAL' as const,
      confidence: 1,
    };
  });
  return {
    param_code: paramCode,
    ...(expected.trim() ? { expected_value: expected.trim() } : {}),
    ...(actual.trim() ? { actual_value: actual.trim() } : {}),
    fragments: [...fromEvidence, ...fromDrawn] as Fragment[],
    ...(comment.trim() ? { comment: comment.trim() } : {}),
  };
};

export type SuspicionFilter = 'all' | ApiSuspicion['inspector_status'];

/** Список гипотез для панели: по статусу и по тексту (описание, документы, способ поиска). */
export const filterSuspicions = (list: ApiSuspicion[], filter: SuspicionFilter, query: string): ApiSuspicion[] => {
  const q = query.trim().toLowerCase();
  return list.filter(
    (s) =>
      (filter === 'all' || s.inspector_status === filter) &&
      (!q || [s.description, suspicionRefs(s), METHOD_LABEL[s.discovery_method]].join(' ').toLowerCase().includes(q))
  );
};
