import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './client';
import type { components } from './schema';
import type { UserRole } from '@/shared/types';

export type ApiNotification = components['schemas']['Notification'];

const REFRESH_MS = 30_000;

/**
 * Какие уведомления нужны роли. Сервер отдаёт всем один общий набор («Протокол готов» приходит и администратору, и ML-инженеру),
 * а ML-инженеру о готовности чужого протокола знать незачем. Контракт: `RETRAIN_ITEM_PENDING` адресован ADMIN,
 * `UNFINALIZE_REQUESTED` адресован ADMIN и SUPERVISOR. Администратору показываем всё: у него есть переходы к протоколу.
 */
const TYPES_FOR_ROLE: Record<UserRole, ReadonlyArray<ApiNotification['type']>> = {
  INSPECTOR: ['PROTOCOL_READY', 'PROCESS_FAILED', 'NEW_DOCUMENTS_AVAILABLE', 'SYNC_FAILED', 'ADMIN_ALERT'],
  SUPERVISOR: ['PROTOCOL_READY', 'PROCESS_FAILED', 'NEW_DOCUMENTS_AVAILABLE', 'SYNC_FAILED', 'ADMIN_ALERT', 'UNFINALIZE_REQUESTED'],
  ADMIN: ['PROTOCOL_READY', 'PROCESS_FAILED', 'NEW_DOCUMENTS_AVAILABLE', 'SYNC_FAILED', 'ADMIN_ALERT', 'RETRAIN_ITEM_PENDING', 'UNFINALIZE_REQUESTED'],
  ML_ENGINEER: ['PROCESS_FAILED', 'ADMIN_ALERT', 'RETRAIN_ITEM_PENDING'],
};

export const isNotificationForRole = (role: UserRole | undefined, type: ApiNotification['type']): boolean =>
  role ? TYPES_FOR_ROLE[role].includes(type) : true;

/** `GET /notifications`: уведомления текущего пользователя, свежие раньше, только нужные его роли. Опрос раз в 30 с. */
export const useNotifications = (enabled: boolean, role?: UserRole) =>
  useQuery<ApiNotification[]>({
    queryKey: ['notifications', role ?? 'any'],
    enabled,
    refetchInterval: REFRESH_MS,
    retry: 0,
    queryFn: async () => {
      const { data, error } = await apiClient.GET('/api/v1/notifications', { params: { query: {} } });
      if (error || !data) throw new Error('Не удалось загрузить уведомления');
      return data.filter((n) => isNotificationForRole(role, n.type)).sort((a, b) => b.created_at.localeCompare(a.created_at));
    },
  });

/** Одинаковые уведомления об одном проекте («Протокол готов…» после каждого пересчёта) схлопываются в одно с числом повторов. */
export interface NotificationGroup {
  latest: ApiNotification;
  ids: string[];
  unreadIds: string[];
  count: number;
}

export const groupNotifications = (list: ApiNotification[]): NotificationGroup[] => {
  const groups = new Map<string, NotificationGroup>();
  for (const n of list) {
    const key = `${n.type}|${n.object_id ?? ''}|${n.message}`;
    const group = groups.get(key);
    if (group) {
      group.ids.push(n.id);
      group.count += 1;
      if (!n.is_read) group.unreadIds.push(n.id);
    } else {
      groups.set(key, { latest: n, ids: [n.id], unreadIds: n.is_read ? [] : [n.id], count: 1 });
    }
  }
  // Список уже отсортирован от новых к старым, Map хранит порядок первого появления: сверху группа со свежим уведомлением
  return [...groups.values()];
};

/** `POST /notifications/{id}/read`. */
export const markNotificationRead = async (id: string): Promise<void> => {
  const { error } = await apiClient.POST('/api/v1/notifications/{notification_id}/read', { params: { path: { notification_id: id } } });
  if (error) throw new Error('Не удалось отметить уведомление прочитанным');
};

export const useMarkRead = () => {
  const queryClient = useQueryClient();
  return async (ids: string[]) => {
    await Promise.allSettled(ids.map(markNotificationRead));
    await queryClient.invalidateQueries({ queryKey: ['notifications'] });
  };
};

/** Сколько гипотез назвал сервер в тексте уведомления о готовом протоколе («…кандидатов 1, гипотез 2»); 0, если не названо. */
export const hypothesesCountIn = (message: string): number => {
  const match = /гипотез\D{0,5}(\d+)/i.exec(message);
  return match ? Number(match[1]) : 0;
};

export const NOTIFICATION_TITLE: Record<ApiNotification['type'], string> = {
  PROTOCOL_READY: 'Протокол готов',
  PROCESS_FAILED: 'Ошибка обработки',
  NEW_DOCUMENTS_AVAILABLE: 'Новые документы',
  SYNC_FAILED: 'Передача не удалась',
  ADMIN_ALERT: 'Сообщение администратора',
  RETRAIN_ITEM_PENDING: 'Запись для дообучения ждёт решения',
  UNFINALIZE_REQUESTED: 'Запрос на откат финализации',
};
