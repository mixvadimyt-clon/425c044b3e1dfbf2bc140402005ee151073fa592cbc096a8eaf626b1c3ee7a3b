import { useQuery } from '@tanstack/react-query';
import { apiClient } from './client';

export class MlflowUnavailableError extends Error {}

/** `POST /admin/mlflow/session` ставит cookie для `/mlflow/` и отдаёт путь, куда открыть MLflow. */
export const useMlflowSession = () =>
  useQuery({
    queryKey: ['mlflow-session'],
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data, error, response } = await apiClient.POST('/api/v1/admin/mlflow/session');
      if (response.status === 503) throw new MlflowUnavailableError();
      if (error || !data) throw new Error(error?.message ?? 'Не удалось открыть сессию MLflow');
      return data;
    },
  });
