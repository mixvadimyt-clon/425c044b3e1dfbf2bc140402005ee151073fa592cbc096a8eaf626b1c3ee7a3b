import React from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { apiClient } from './client';
import type { components } from './schema';
import type { FileInfo } from './processes';
import { toStageComparisons } from '@/shared/stageComparisons';
import { withoutLongDash } from '@/shared/text';
import { APPROVAL_STATUS } from '@/shared/statuses';
import { formatDateTime } from './protocols';
import type { DecisionEntry, DraftFragment, EvidenceVersionEntry, Finding, FragmentInfo, RejectReason, Source } from '@/shared/verification';

export type ApiFinding = components['schemas']['Finding'];
export type DecisionRequest = components['schemas']['DecisionRequest'];
type Fragment = components['schemas']['EvidenceFragment'];

const STAGE_KEY = { PD: 'pd', RD: 'rd', ID: 'id_' } as const;

const toBox = (fragment: Fragment) => {
  const [x0, y0, x1, y1] = fragment.bbox;
  return { x: x0 * 100, y: y0 * 100, w: (x1 - x0) * 100, h: (y1 - y0) * 100 };
};

/** `extraction_method`: `null` значит то же, что `RULES` (старые протоколы и области, указанные вручную). */
export const isBySense = (fragment: Pick<Fragment, 'extraction_method'>): boolean => fragment.extraction_method === 'SBERT';

const toSource = (fragment: Fragment, file: FileInfo | undefined): Source => {
  const approval = fragment.approval_status && fragment.approval_status !== 'UNKNOWN' ? APPROVAL_STATUS[fragment.approval_status].label : undefined;
  const docName = [
    file?.original_name ?? fragment.document_code,
    fragment.revision ? `ред. ${fragment.revision}` : undefined,
    approval,
  ]
    .filter(Boolean)
    .join(', ');
  return {
    page: fragment.page,
    value: fragment.extracted_value ?? fragment.normalized_value ?? '',
    bbox: toBox(fragment),
    docName,
    fileId: fragment.file_id,
    snippet: fragment.text_snippet ?? undefined,
    role: fragment.role,
    sheet: fragment.sheet ?? undefined,
    bySense: isBySense(fragment) || undefined,
    marks: [],
  };
};

/** Модель не смогла выбрать значение («требуется уточнение»), инспектор ещё не решил: запись во вкладке «Уточнено». */
export const isModelClarification = (f: Pick<ApiFinding, 'finding_status' | 'inspector_status'>): boolean =>
  f.finding_status === 'CLARIFICATION_REQUIRED' && f.inspector_status === 'PENDING';

/** Кандидат ждёт решения; решённые и «требуется уточнение» остаются в списке, чтобы решение можно было принять или изменить. */
export const isVerifiable = (f: ApiFinding): boolean =>
  !f.is_split && (f.finding_status === 'CANDIDATE' || f.finding_status === 'CLARIFICATION_REQUIRED' || f.inspector_status !== 'PENDING');

const toLocalStatus = (f: ApiFinding): Finding['status'] => {
  switch (f.inspector_status) {
    case 'CONFIRMED_VIOLATION':
      return 'confirmed';
    case 'NEGATIVE_VERIFIED':
      return 'rejected';
    case 'CLARIFICATION_REQUIRED':
      return 'clarification';
    default:
      return isModelClarification(f) ? 'clarification' : 'CANDIDATE';
  }
};

export const toFinding = (f: ApiFinding, files: FileInfo[]): Finding => {
  const filesById = new Map(files.map((file) => [file.id, file]));
  const sources: Finding['sources'] = {};
  for (const fragment of f.evidence_group.fragments) {
    const key = STAGE_KEY[fragment.stage];
    // Первый фрагмент стадии — основной; остальные (того же файла) рисуются рамками на своих страницах
    const main = sources[key];
    if (!main) sources[key] = toSource(fragment, filesById.get(fragment.file_id));
    if (!main || main.fileId === fragment.file_id) {
      sources[key]!.marks!.push({
        page: fragment.page,
        bbox: toBox(fragment),
        value: fragment.extracted_value ?? fragment.normalized_value ?? '',
        role: fragment.role,
        fragmentId: fragment.id,
        manual: fragment.source === 'MANUAL' || undefined,
        bySense: isBySense(fragment) || undefined,
      });
    }
  }
  const comparison = f.expected_value && f.actual_value ? `${f.expected_value} → ${f.actual_value}${f.unit ? ` ${f.unit}` : ''}` : undefined;
  return {
    finding_id: f.id,
    code: f.param_code,
    parameter_name: f.param_name ?? f.param_code,
    section: f.section ?? '',
    review_priority: f.review_priority,
    rationale: f.rationale ? withoutLongDash(f.rationale) : undefined,
    triggerLogic: f.trigger_logic ? withoutLongDash(f.trigger_logic) : undefined,
    description: [comparison, f.rationale ? withoutLongDash(f.rationale) : ''].filter(Boolean).join('. ') || 'Расхождение между стадиями',
    sources,
    gost_reference: f.normative_reference ?? undefined,
    status: toLocalStatus(f),
    modelClarification: isModelClarification(f) || undefined,
    inspector_comment: f.decision?.comment ?? undefined,
    reason_code: (f.decision?.reason_code as RejectReason | null | undefined) ?? undefined,
    ruleKey: f.rule_key ?? undefined,
    delta: f.delta ?? undefined,
    stageComparisons: toStageComparisons(f.stage_comparisons),
    rationaleSource: f.rationale ? (f.rationale_source === 'LLM' ? 'AI' : 'RULES') : undefined,
    evidenceChanged: f.evidence_changed || undefined,
    fragments: toFragments(f),
    decisionHistory: toDecisionHistory(f),
    evidenceVersions: toEvidenceVersions(f),
  };
};

const STAGE_LABEL_RU = { PD: 'ПД', RD: 'РД', ID: 'ИД' } as const;

export const toFragments = (f: ApiFinding): FragmentInfo[] =>
  f.evidence_group.fragments
    .filter((fragment): fragment is Fragment & { id: string } => Boolean(fragment.id))
    .map((fragment) => ({
      id: fragment.id,
      stage: STAGE_LABEL_RU[fragment.stage],
      page: fragment.page,
      value: fragment.extracted_value ?? fragment.normalized_value ?? '',
      role: fragment.role,
      manual: fragment.source === 'MANUAL',
    }));

export interface SplitPart {
  rule_key: string;
  expected_value?: string;
  actual_value?: string;
  fragment_ids: string[];
  comment?: string;
}

/** POST /findings/{id}/split: составной кандидат → атомарные findings (исходный перестаёт верифицироваться). */
export const splitFinding = async (findingId: string, parts: SplitPart[]): Promise<ApiFinding[]> => {
  const { data, error } = await apiClient.POST('/api/v1/findings/{finding_id}/split', { params: { path: { finding_id: findingId } }, body: { parts } });
  if (error || !data) throw new Error(error?.message ?? 'Не удалось разделить кандидата');
  return data;
};

/** История решений: новые сверху; текущее решение входит в неё, если api не продублировал его в `decision_history`. */
export const toDecisionHistory = (f: ApiFinding): DecisionEntry[] => {
  const all = [...(f.decision_history ?? [])];
  if (f.decision && !all.some((d) => d.decided_at === f.decision!.decided_at)) all.push(f.decision);
  return all
    .sort((a, b) => b.decided_at.localeCompare(a.decided_at))
    .map((d) => ({
      action: d.action,
      reasonCode: (d.reason_code as RejectReason | null | undefined) ?? undefined,
      comment: d.comment ?? undefined,
      by: d.user_name ?? undefined,
      at: formatDateTime(d.decided_at),
    }));
};

export const toEvidenceVersions = (f: ApiFinding): EvidenceVersionEntry[] =>
  (f.evidence_history ?? []).map((v) => ({
    version: v.version,
    source: v.source,
    by: v.created_by_name ?? undefined,
    at: formatDateTime(v.created_at),
    reason: v.reason ?? undefined,
    reference: v.reference ?? undefined,
    fragments: v.fragments_count,
  }));

/** Максимум `page_size` по контракту. */
const FINDINGS_PAGE_SIZE = 200;

/**
 * Все страницы списка подряд. Проверок в протоколе бывает больше 200 (на обучающих объектах — 267 и 371), а api ставит решённые
 * в конец, поэтому по одной странице решения инспектора пропадали из вкладок, прогресс стоял, в таблицах протокола не хватало строк.
 */
export const collectPages = async <T>(fetchPage: (page: number) => Promise<{ items: T[]; total: number }>): Promise<T[]> => {
  const items: T[] = [];
  for (let page = 1; ; page += 1) {
    const data = await fetchPage(page);
    items.push(...data.items);
    if (data.items.length === 0 || items.length >= data.total) return items;
  }
};

const fetchProtocolFindings = (protocolId: string): Promise<ApiFinding[]> =>
  collectPages(async (page) => {
    const { data, error } = await apiClient.GET('/api/v1/protocols/{protocol_id}/findings', {
      params: { path: { protocol_id: protocolId }, query: { page, page_size: FINDINGS_PAGE_SIZE } },
    });
    if (error || !data) throw new Error('Не удалось загрузить кандидатов');
    return data;
  });

export const useProtocolFindings = (protocolId: string | null | undefined) =>
  useQuery({
    queryKey: ['protocol-findings', protocolId],
    enabled: Boolean(protocolId),
    staleTime: 0,
    queryFn: () => fetchProtocolFindings(protocolId!),
  });

/**
 * Несоответствия нескольких версий протокола одним списком: запись для дообучения остаётся в той версии, где инспектор
 * принял решение, даже если проект потом пересчитали. Данные есть, только когда загрузились все версии.
 */
export const useProtocolsFindings = (protocolIds: string[]) => {
  const results = useQueries({
    queries: protocolIds.map((id) => ({ queryKey: ['protocol-findings', id], staleTime: 0, queryFn: () => fetchProtocolFindings(id) })),
  });
  const stamp = results.map((r) => r.dataUpdatedAt).join(',');
  const ready = protocolIds.length > 0 && results.every((r) => r.isSuccess);
  // Тот же массив, пока ничего не перезагружалось: от него зависят эффекты страницы
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const data = React.useMemo(() => (ready ? results.flatMap((r) => r.data ?? []) : undefined), [ready, stamp]);
  return { data, isLoading: results.some((r) => r.isLoading), isSuccess: ready };
};

/** POST /findings/{id}/decision: CONFIRM, REJECT (причина и комментарий обязательны) или CLARIFY. */
export const decideFinding = async (findingId: string, body: DecisionRequest): Promise<ApiFinding> => {
  const { data, error } = await apiClient.POST('/api/v1/findings/{finding_id}/decision', { params: { path: { finding_id: findingId } }, body });
  if (error || !data) throw new Error(error?.message ?? 'Не удалось сохранить решение');
  return data;
};

export interface EvidenceEditInput {
  added: DraftFragment[];
  removedIds: string[];
  reason: string;
  reference?: string;
}

/** Тело `POST /findings/{id}/evidence`: рамки в долях страницы `[x0, y0, x1, y1]`, значение — как ввёл инспектор. */
export const toEvidenceEditBody = ({ added, removedIds, reason, reference }: EvidenceEditInput) => ({
  add: added.map((d) => ({
    role: d.role,
    file_id: d.fileId,
    page: d.page,
    bbox: [d.bbox.x / 100, d.bbox.y / 100, (d.bbox.x + d.bbox.w) / 100, (d.bbox.y + d.bbox.h) / 100] as [number, number, number, number],
    ...(d.value.trim() ? { extracted_value: d.value.trim() } : {}),
  })),
  remove_fragment_ids: removedIds,
  reason: reason.trim(),
  ...(reference?.trim() ? { reference: reference.trim() } : {}),
});

/** POST /findings/{id}/evidence: новая версия доказательств (машинная остаётся в истории). */
export const editEvidence = async (findingId: string, input: EvidenceEditInput): Promise<ApiFinding> => {
  const { data, error } = await apiClient.POST('/api/v1/findings/{finding_id}/evidence', {
    params: { path: { finding_id: findingId } },
    body: toEvidenceEditBody(input),
  });
  if (error || !data) throw new Error(error?.message ?? 'Не удалось сохранить правку доказательств');
  return data;
};

/** POST /findings/bulk-decision: только CONFIRM и CLARIFY и только кандидаты одного параметра (массового отклонения нет). */
export const bulkDecideFindings = async (findingIds: string[], action: 'CONFIRM' | 'CLARIFY', comment?: string): Promise<ApiFinding[]> => {
  const { data, error } = await apiClient.POST('/api/v1/findings/bulk-decision', {
    body: { finding_ids: findingIds, action, ...(comment?.trim() ? { comment: comment.trim() } : {}) },
  });
  if (error || !data) throw new Error(error?.message ?? 'Не удалось применить массовое решение');
  return data;
};
