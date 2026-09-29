import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './client';
import type { components } from './schema';
import { withoutLongDash } from '@/shared/text';

export type IntegrationPackage = components['schemas']['IntegrationPackage'];
export type IntegrationPackageStatus = components['schemas']['IntegrationPackageStatus'];
type ApiError = components['schemas']['Error'];

// Тот же ключ, что у плашки обмена в шапке (useIntegrationStatus в api/system.ts): после забора обновляются обе
const STATUS_KEY = ['integration-status'] as const;
const PACKAGES_KEY = ['integration-packages'] as const;
const REFRESH_MS = 15_000;

const messageOf = (error: unknown, fallback: string): string => withoutLongDash((error as Partial<ApiError> | undefined)?.message ?? fallback);

/** `GET /integration/packages`: пакеты, полученные из внешней ИС, новые сверху. */
export const useIntegrationPackages = () =>
  useQuery({
    queryKey: PACKAGES_KEY,
    refetchInterval: REFRESH_MS,
    retry: 0,
    queryFn: async () => {
      const { data, error } = await apiClient.GET('/api/v1/integration/packages', { params: { query: {} } });
      if (error || !data) throw new Error(messageOf(error, 'Не удалось получить пакеты'));
      return data;
    },
  });

const refreshAll = (queryClient: ReturnType<typeof useQueryClient>) => {
  void queryClient.invalidateQueries({ queryKey: STATUS_KEY });
  void queryClient.invalidateQueries({ queryKey: PACKAGES_KEY });
  void queryClient.invalidateQueries({ queryKey: ['notifications'] });
};

/** `POST /integration/pull`: забрать новые пакеты сейчас. 502 (внешняя ИС недоступна) и 409 (не настроена): текст сервера в `message`. */
export const usePullPackages = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await apiClient.POST('/api/v1/integration/pull');
      if (error || !data) throw new Error(messageOf(error, 'Не удалось забрать документы'));
      return data.packages;
    },
    onSettled: () => refreshAll(queryClient),
  });
};

/** `POST /integration/packages/{id}/apply`: создать проверку из отложенного или неудачного пакета. */
export const useApplyPackage = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await apiClient.POST('/api/v1/integration/packages/{package_id}/apply', { params: { path: { package_id: id } } });
      if (error || !data) throw new Error(messageOf(error, 'Не удалось создать проверку'));
      return data;
    },
    onSettled: () => refreshAll(queryClient),
  });
};

/** Период автозабора словами: 0 — только вручную. */
export const pollIntervalText = (seconds: number | undefined): string => {
  if (!seconds) return 'только вручную';
  if (seconds % 3600 === 0) return `каждые ${seconds / 3600} ч`;
  if (seconds % 60 === 0) return `каждые ${seconds / 60} мин`;
  return `каждые ${seconds} с`;
};
