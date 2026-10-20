import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_URL, apiClient } from './client';
import { fileNameFromDisposition } from './protocols';
import { withoutLongDash } from '@/shared/text';
import type { components } from './schema';

export type DatasetItem = components['schemas']['DatasetItem'];
export type DatasetVersion = components['schemas']['DatasetVersion'];
export type ModelVersion = components['schemas']['ModelVersion'];
export type ThresholdCheck = components['schemas']['ThresholdCheck'];
export type WeeklyReport = components['schemas']['WeeklyReport'];
export type CurationStatus = components['schemas']['CurationStatus'];
type ApiError = components['schemas']['Error'];

/** Ошибка api с кодом и подробностями: по коду интерфейс говорит человеческим языком (`THRESHOLDS_FAILED`, `VERSION_EXISTS`…). */
export class MlApiError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

const fail = (error: unknown, fallback: string): never => {
  const e = error as Partial<ApiError> | undefined;
  throw new MlApiError(withoutLongDash(e?.message ?? fallback), e?.code, e?.details as Record<string, unknown> | undefined);
};

export const ITEMS_PAGE_SIZE = 15;

const ITEMS_KEY = ['ml-dataset-items'] as const;
const VERSIONS_KEY = ['ml-dataset-versions'] as const;
const MODELS_KEY = ['ml-models'] as const;

/** `GET /ml/dataset-items`: записи GOLD-набора (черновики, одобренные, исключённые). */
export const useDatasetItems = (status: CurationStatus | undefined, page: number) =>
  useQuery({
    queryKey: [...ITEMS_KEY, status ?? 'ALL', page],
    queryFn: async () => {
      const { data, error } = await apiClient.GET('/api/v1/ml/dataset-items', {
        params: { query: { curation_status: status, page, page_size: ITEMS_PAGE_SIZE } },
      });
      if (error || !data) return fail(error, 'Не удалось загрузить записи набора');
      return data;
    },
  });

/** `POST /ml/dataset-items/{id}/curate`: куратор одобряет запись или исключает. Выпущенную запись менять нельзя (409). */
export const useCurateItem = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status, comment }: { id: string; status: 'APPROVED' | 'EXCLUDED'; comment?: string }) => {
      const { data, error } = await apiClient.POST('/api/v1/ml/dataset-items/{item_id}/curate', {
        params: { path: { item_id: id } },
        body: { curation_status: status, comment },
      });
      if (error || !data) return fail(error, 'Не удалось изменить запись');
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ITEMS_KEY });
      // Тот же список читает разбор для дообучения у администратора (дашборд и верификация)
      void queryClient.invalidateQueries({ queryKey: ['dataset-items'] });
    },
  });
};

/** `GET /ml/dataset-versions`: выпущенные версии набора. */
export const useDatasetVersions = () =>
  useQuery({
    queryKey: VERSIONS_KEY,
    queryFn: async () => {
      const { data, error } = await apiClient.GET('/api/v1/ml/dataset-versions');
      if (error || !data) return fail(error, 'Не удалось загрузить версии набора');
      return [...data].sort((a, b) => b.created_at.localeCompare(a.created_at));
    },
  });

/** `POST /ml/dataset-versions`: выпуск версии. В ответе `excluded` — одобренные записи без полного доказательства. */
export const useReleaseVersion = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ version, comment }: { version: string; comment?: string }) => {
      const { data, error } = await apiClient.POST('/api/v1/ml/dataset-versions', { body: { version, comment: comment || undefined } });
      if (error || !data) return fail(error, 'Не удалось выпустить версию');
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: VERSIONS_KEY });
      void queryClient.invalidateQueries({ queryKey: ITEMS_KEY });
    },
  });
};

/** `GET /ml/dataset-versions/{version}/export`: выгрузка версии в JSONL (Bearer сам браузер не подставит, поэтому через fetch). */
export const downloadDatasetVersion = async (version: string): Promise<void> => {
  const token = localStorage.getItem('auth_token');
  const response = await fetch(`${API_URL}/api/v1/ml/dataset-versions/${encodeURIComponent(version)}/export`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `Не удалось выгрузить версию (${response.status})`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileNameFromDisposition(response.headers.get('content-disposition')) ?? `${version}.jsonl`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
};

/** `GET /ml/models`: реестр моделей, новые сверху. */
export const useModels = () =>
  useQuery({
    queryKey: MODELS_KEY,
    queryFn: async () => {
      const { data, error } = await apiClient.GET('/api/v1/ml/models');
      if (error || !data) return fail(error, 'Не удалось загрузить модели');
      return data;
    },
  });

export type ModelAction = 'APPROVE' | 'REJECT' | 'ROLLBACK';

/** `POST /ml/models/{v}/decision`: одобрить, отклонить, откатить; комментарий обязателен. */
export const useDecideModel = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ version, action, comment }: { version: string; action: ModelAction; comment: string }) => {
      const { data, error } = await apiClient.POST('/api/v1/ml/models/{model_version}/decision', {
        params: { path: { model_version: version } },
        body: { action, comment },
      });
      if (error || !data) return fail(error, 'Не удалось сохранить решение');
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: MODELS_KEY }),
  });
};

/** `GET /ml/reports/weekly?week=2026-W38`. */
export const useWeeklyReport = (week: string) =>
  useQuery({
    queryKey: ['ml-weekly-report', week],
    queryFn: async () => {
      const { data, error } = await apiClient.GET('/api/v1/ml/reports/weekly', { params: { query: { week } } });
      if (error || !data) return fail(error, 'Не удалось построить отчёт');
      return data;
    },
  });

/** Проверки приёмки, не прошедшие при отказе `THRESHOLDS_FAILED`: сервер кладёт их в `details.failed`. */
export const failedChecksOf = (error: unknown): string[] => {
  if (!(error instanceof MlApiError) || error.code !== 'THRESHOLDS_FAILED') return [];
  const failed = error.details?.failed;
  if (!Array.isArray(failed)) return [];
  return failed.map((item) => withoutLongDash(typeof item === 'string' ? item : ((item as { message?: string }).message ?? JSON.stringify(item))));
};

/** ISO-неделя вида `2026-W38` для даты (по её календарным числам, без часового пояса). */
export const isoWeekOf = (date: Date): string => {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNumber = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNumber);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
};

/** Сдвиг ISO-недели на `delta` недель: `2026-W01` − 1 → `2025-W52`. */
export const shiftIsoWeek = (week: string, delta: number): string => {
  const match = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!match) return week;
  const jan4 = new Date(Date.UTC(Number(match[1]), 0, 4));
  const monday = new Date(jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * 86_400_000);
  monday.setUTCDate(monday.getUTCDate() + (Number(match[2]) - 1 + delta) * 7);
  return isoWeekOf(new Date(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate()));
};

/** Следующее имя версии набора по образцу `ds-2026.09.1`: месяц из даты, номер на единицу больше уже выпущенных за месяц. */
export const suggestNextVersion = (versions: Array<{ version: string }>, now: Date): string => {
  const prefix = `ds-${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.`;
  const used = versions
    .map((v) => (v.version.startsWith(prefix) ? Number(v.version.slice(prefix.length)) : 0))
    .filter((n) => Number.isFinite(n));
  return `${prefix}${Math.max(0, ...used) + 1}`;
};
