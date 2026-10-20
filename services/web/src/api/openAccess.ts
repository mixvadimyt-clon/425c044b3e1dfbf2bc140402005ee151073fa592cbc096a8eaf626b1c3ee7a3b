import { useQuery } from '@tanstack/react-query';
import { apiClient } from './client';
import type { components } from './schema';

export type AuthAccount = components['schemas']['AuthAccount'];

/**
 * Учётные записи открытого входа (`GET /auth/options`, OPEN_ACCESS у api на время экспертизы).
 * Пусто, если вход по паролю, api старее 0.24.0 или недоступен: тогда «Сменить роль» в меню не показывается.
 */
export const useOpenAccessAccounts = (enabled: boolean) =>
  useQuery({
    queryKey: ['auth-options'],
    enabled,
    staleTime: 5 * 60_000,
    retry: 0,
    queryFn: async (): Promise<AuthAccount[]> => {
      try {
        const { data } = await apiClient.GET('/api/v1/auth/options');
        return data?.open_access ? data.accounts : [];
      } catch {
        return [];
      }
    },
  });
