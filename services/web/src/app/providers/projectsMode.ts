/**
 * `query.isError` не годится: когда кеш уже содержит данные, React Query после неудачного
 * фонового обновления оставляет `status` прежним, и полоса «нет связи» не появляется —
 * сравниваем время последней ошибки и последнего успеха напрямую.
 */
export const computeProjectsMode = (params: {
  demoMode: boolean;
  hasData: boolean;
  dataUpdatedAt: number;
  errorUpdatedAt: number;
}): 'live' | 'demo' | 'offline' | 'stale' => {
  if (params.demoMode) return 'demo';
  const lastFetchFailed = params.errorUpdatedAt > params.dataUpdatedAt;
  if (!lastFetchFailed) return 'live';
  return params.hasData ? 'stale' : 'offline';
};
