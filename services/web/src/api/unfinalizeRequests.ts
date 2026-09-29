import { useQuery } from '@tanstack/react-query';
import { apiClient } from './client';
import type { components } from './schema';

export type UnfinalizeRequest = components['schemas']['UnfinalizeRequest'];
export type UnfinalizeRequestStatus = components['schemas']['UnfinalizeRequestStatus'];

/** Повторный запрос на тот же процесс: открытый уже есть (409). */
export class RequestExistsError extends Error {
  constructor() {
    super('Запрос на откат уже отправлен и ждёт решения');
  }
}

/** `GET /unfinalize-requests`: запросы инспекторов на откат финализации (читают ADMIN и SUPERVISOR), новые сверху. */
export const useUnfinalizeRequests = (enabled: boolean, status: UnfinalizeRequestStatus = 'OPEN') =>
  useQuery<UnfinalizeRequest[]>({
    queryKey: ['unfinalize-requests', status],
    enabled,
    staleTime: 0,
    retry: 0,
    queryFn: async () => {
      const { data, error } = await apiClient.GET('/api/v1/unfinalize-requests', { params: { query: { status } } });
      if (error || !data) throw new Error('Не удалось загрузить запросы на откат финализации');
      return data;
    },
  });

/** `POST /processes/{id}/unfinalize-request`: инспектор просит откат с причиной; открытый запрос на процесс один (409). */
export const requestUnfinalize = async (processId: string, reason: string): Promise<UnfinalizeRequest> => {
  const { data, error, response } = await apiClient.POST('/api/v1/processes/{process_id}/unfinalize-request', {
    params: { path: { process_id: processId } },
    body: { reason },
  });
  if (response.status === 409) throw new RequestExistsError();
  if (error || !data) throw new Error(error?.message ?? 'Не удалось отправить запрос на откат');
  return data;
};

/** `POST /unfinalize-requests/{id}/reject`: администратор или руководитель отклоняет запрос с причиной. */
export const rejectUnfinalizeRequest = async (requestId: string, reason: string): Promise<UnfinalizeRequest> => {
  const { data, error } = await apiClient.POST('/api/v1/unfinalize-requests/{request_id}/reject', {
    params: { path: { request_id: requestId } },
    body: { reason },
  });
  if (error || !data) throw new Error(error?.message ?? 'Не удалось отклонить запрос');
  return data;
};
