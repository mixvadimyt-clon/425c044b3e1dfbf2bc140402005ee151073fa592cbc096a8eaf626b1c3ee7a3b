import { useQueries, useQuery } from '@tanstack/react-query';
import React from 'react';
import { apiClient } from './client';
import { useMatrixParams } from './suspicions';
import { useProjects } from '@/app/providers/useProjects';
import type { components } from './schema';
import type { RetrainItem, RetrainStatus } from '@/shared/retrainQueue';

export type DatasetItem = components['schemas']['DatasetItem'];
export type CurationStatus = components['schemas']['CurationStatus'];

/** `GET /ml/dataset-items`: записи GOLD-набора, созданные из решений инспекторов (читает администратор и ML-инженер). */
export const useDatasetItems = (enabled: boolean) =>
  useQuery({
    queryKey: ['dataset-items'],
    enabled,
    staleTime: 0,
    queryFn: async () => {
      const { data, error } = await apiClient.GET('/api/v1/ml/dataset-items', { params: { query: { page_size: 200 } } });
      if (error || !data) throw new Error('Не удалось загрузить записи для дообучения');
      return data.items;
    },
  });

/** `POST /ml/dataset-items/{id}/curate`: одобрить запись для дообучения или исключить её; выпущенные версии не меняются (409). */
export const curateDatasetItem = async (id: string, curation: 'APPROVED' | 'EXCLUDED', comment?: string): Promise<DatasetItem> => {
  const { data, error } = await apiClient.POST('/api/v1/ml/dataset-items/{item_id}/curate', {
    params: { path: { item_id: id } },
    body: { curation_status: curation, ...(comment?.trim() ? { comment: comment.trim() } : {}) },
  });
  if (error || !data) throw new Error((error as { message?: string } | undefined)?.message ?? 'Не удалось сохранить решение по записи');
  return data;
};

/** Статус записи GOLD → статус разбора: черновик ждёт решения, одобренная уходит на дообучение, исключённая — нет. */
export const RETRAIN_STATUS_OF: Record<CurationStatus, RetrainStatus> = {
  DRAFT: 'pending',
  APPROVED: 'sent',
  EXCLUDED: 'skipped',
};

export const toRetrainItem = (item: DatasetItem, projectName: string | undefined, parameterName: string | undefined): RetrainItem => ({
  id: item.id,
  findingId: item.finding_id ?? '',
  projectId: item.object_group_id,
  projectName: projectName ?? 'Проект',
  parameter: parameterName ? `${item.param_code ?? ''}, ${parameterName}` : (item.param_code ?? 'нет'),
  inspector: 'Инспектор',
  timestamp: item.created_at ?? '',
  reasonCode: item.reason_code ?? undefined,
  verdict: item.gold_label === 'POSITIVE' ? 'confirmed' : 'rejected',
  inspectorComment: '',
  status: RETRAIN_STATUS_OF[item.curation_status],
  datasetVersion: item.dataset_version ?? undefined,
});

/** Записи разбора для дообучения с названиями проектов и параметров. */
export const useRetrainItems = (enabled: boolean) => {
  const query = useDatasetItems(enabled);
  const { projects } = useProjects();
  const params = useMatrixParams(enabled);
  const items = React.useMemo(() => {
    const projectNames = new Map(projects.map((p) => [p.id, p.name]));
    const parameterNames = new Map((params.data ?? []).map((p) => [p.code, p.parameter_name]));
    return (query.data ?? []).map((item) => toRetrainItem(item, projectNames.get(item.object_group_id), item.param_code ? parameterNames.get(item.param_code) : undefined));
  }, [query.data, projects, params.data]);
  return { items, isLoading: query.isLoading, isError: query.isError, refetch: query.refetch };
};

/**
 * Версия протокола, которой принадлежит каждое несоответствие (`GET /findings/{id}`). Запись для дообучения привязана к
 * несоответствию из версии, где инспектор принял решение: после пересчёта проекта в свежей версии его уже нет.
 */
export const useFindingProtocolIds = (findingIds: string[]) => {
  const results = useQueries({
    queries: findingIds.map((id) => ({
      queryKey: ['finding-protocol', id],
      staleTime: 60_000,
      queryFn: async () => {
        const { data, error } = await apiClient.GET('/api/v1/findings/{finding_id}', { params: { path: { finding_id: id } } });
        if (error || !data) throw new Error('Не удалось определить версию протокола');
        return data.protocol_id as string;
      },
    })),
  });
  const stamp = results.map((r) => r.data ?? '').join(',');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const protocolIds = React.useMemo(() => new Map(findingIds.flatMap((id, i) => (results[i]?.data ? [[id, results[i].data as string] as const] : []))), [findingIds.join(','), stamp]);
  return { protocolIds, isLoading: results.some((r) => r.isLoading) };
};

/** Запрос комментария инспектора: один ключ на всех, поэтому строка таблицы и массовая загрузка не дублируют запросы. */
const decisionCommentQuery = (id: string) => ({
  queryKey: ['finding-decision', id] as const,
  staleTime: 60_000,
  queryFn: async (): Promise<string> => {
    const { data, error } = await apiClient.GET('/api/v1/findings/{finding_id}', { params: { path: { finding_id: id } } });
    if (error || !data) throw new Error('Не удалось загрузить решение инспектора');
    return data.decision?.comment ?? '';
  },
});

/**
 * Комментарии инспектора к решениям (`GET /findings/{id}`): в самой записи набора их нет. Ключ: id несоответствия.
 * Один запрос на запись, поэтому массово читаем только когда нужно (поиск по комментарию), а обычно по одному на видимую строку
 * (`useInspectorComment`).
 */
export const useInspectorComments = (findingIds: string[], enabled = true): Map<string, string> => {
  const results = useQueries({ queries: findingIds.map((id) => ({ ...decisionCommentQuery(id), enabled })) });
  return new Map(findingIds.map((id, index) => [id, results[index]?.data ?? '']));
};

/** Комментарий инспектора одной записи: строка таблицы просит его сама, поэтому читаются только показанные строки. */
export const useInspectorComment = (findingId: string | undefined): string | undefined =>
  useQuery({ ...decisionCommentQuery(findingId ?? ''), enabled: Boolean(findingId) }).data;
